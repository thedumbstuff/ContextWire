pub mod claudecfg;
pub mod hook;
pub mod hookserver;
pub mod pty;
pub mod workspaces;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, UserAttentionType, WindowEvent};

const TRAY_ID: &str = "main";

struct AppState {
    pty: pty::PtyManager,
    data_dir: PathBuf,
    session_settings: Option<PathBuf>,
    endpoint: Option<hookserver::Endpoint>,
    startup_error: Option<String>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    data_dir: String,
    exe: String,
    claude: Option<String>,
    hook_port: Option<u16>,
    global_hooks: bool,
    user_settings: String,
    startup_error: Option<String>,
    autostart_managed: bool,
}

fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("contextwire.exe"))
}

fn find_claude() -> Option<PathBuf> {
    which::which("claude").ok().or_else(|| {
        let p = dirs::home_dir()?.join(".local").join("bin").join("claude.exe");
        p.exists().then_some(p)
    })
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    let us = claudecfg::user_settings_path();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: state.data_dir.display().to_string(),
        exe: exe_path().display().to_string(),
        claude: find_claude().map(|p| p.display().to_string()),
        hook_port: state.endpoint.as_ref().map(|e| e.port),
        global_hooks: claudecfg::global_installed(&us),
        user_settings: us.display().to_string(),
        startup_error: state.startup_error.clone(),
        autostart_managed: !cfg!(debug_assertions),
    }
}

/// Start a `claude` console. `args` are the claude arguments chosen by the UI
/// (e.g. `--session-id <id>` or `--resume <id>`); hooks are added here.
#[tauri::command]
fn session_spawn(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    cwd: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let claude = find_claude().ok_or("claude CLI not found on PATH (expected ~/.local/bin/claude.exe)")?;
    let mut args = args;
    // global hooks already cover every session; adding ours too would double-report
    if !claudecfg::global_installed(&claudecfg::user_settings_path()) {
        if let Some(s) = &state.session_settings {
            args.push("--settings".into());
            args.push(s.display().to_string());
        }
    }
    let env = vec![("CONTEXTWIRE_TAB".to_string(), id.clone())];
    let out_app = app.clone();
    let exit_app = app.clone();
    state.pty.spawn(
        pty::SpawnSpec { id: &id, program: &claude, args: &args, cwd: Path::new(&cwd), env: &env, cols, rows },
        Arc::new(move |id, bytes| {
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            let _ = out_app.emit("pty-output", json!({"id": id, "data": data}));
        }),
        Arc::new(move |id, code| {
            let _ = exit_app.emit("pty-exit", json!({"id": id, "code": code}));
        }),
    )
}

#[tauri::command]
fn session_write(state: State<AppState>, id: String, data: String) -> Result<(), String> {
    state.pty.write(&id, data.as_bytes())
}

#[tauri::command]
fn session_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
fn session_kill(state: State<AppState>, id: String) -> Result<(), String> {
    state.pty.kill(&id)
}

#[tauri::command]
fn sessions_running(state: State<AppState>) -> Vec<String> {
    state.pty.running()
}

#[tauri::command]
async fn past_sessions(limit: Option<usize>) -> Vec<workspaces::PastSession> {
    workspaces::scan(&workspaces::projects_dir(), limit.unwrap_or(300))
}

#[tauri::command]
async fn project_folders() -> Vec<String> {
    workspaces::project_folders(&workspaces::projects_dir())
}

#[tauri::command]
fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    git: bool,
}

/// Immediate, non-hidden subfolders (repos first) - for the New session picker.
#[tauri::command]
async fn list_dirs(path: String) -> Vec<DirEntry> {
    let mut out: Vec<DirEntry> = std::fs::read_dir(&path)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map_or(false, |t| t.is_dir()))
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let skip = name.starts_with('.') || ["node_modules", "venv", ".venv", "__pycache__", "target", "dist"].contains(&name.as_str());
                    (!skip).then(|| DirEntry { git: e.path().join(".git").exists(), name })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.git.cmp(&a.git).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

#[tauri::command]
fn store_load(state: State<AppState>) -> Value {
    std::fs::read_to_string(state.data_dir.join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok()) // tolerate a BOM from hand edits
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn store_save(state: State<AppState>, value: Value) -> Result<(), String> {
    let p = state.data_dir.join("state.json");
    let tmp = state.data_dir.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&value).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn global_hooks_set(enable: bool) -> Result<bool, String> {
    let p = claudecfg::user_settings_path();
    claudecfg::set_global(&p, &claudecfg::hook_command(&exe_path()), enable)?;
    Ok(claudecfg::global_installed(&p))
}

#[tauri::command]
fn attention(app: AppHandle, critical: bool) {
    if let Some(w) = main_window(&app) {
        let focused = w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false);
        if !focused {
            let kind = if critical { UserAttentionType::Critical } else { UserAttentionType::Informational };
            let _ = w.request_user_attention(Some(kind));
        }
    }
}

#[tauri::command]
fn window_focused(app: AppHandle) -> bool {
    main_window(&app).map_or(false, |w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
}

#[tauri::command]
fn tray_status(app: AppHandle, tooltip: String) {
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_tooltip(Some(tooltip));
    }
}

/// Frontend log line -> stderr (visible in `tauri dev` output).
#[tauri::command]
fn ui_log(level: String, msg: String) {
    eprintln!("[ui {level}] {msg}");
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<AppState>) {
    state.pty.kill_all();
    app.exit(0);
}

// ---------------------------------------------------------------- setup

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show ContextWire", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit (ends all sessions)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("ContextWire")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                app.state::<AppState>().pty.kill_all();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let minimized = std::env::args().any(|a| a == "--minimized");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::Builder::new().args(["--minimized"]).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = hookserver::endpoint_file().parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir);
            let _ = std::fs::create_dir_all(&data_dir);

            let mut errors = Vec::new();
            let session_settings = claudecfg::write_session_settings(&data_dir, &exe_path())
                .map_err(|e| errors.push(format!("session hooks: {e}")))
                .ok();
            let ev_app = handle.clone();
            let endpoint = hookserver::start(&hookserver::endpoint_file(), move |v| {
                let _ = ev_app.emit("hook-event", v);
            })
            .map_err(|e| errors.push(format!("hook server: {e}")))
            .ok();

            app.manage(AppState {
                pty: pty::PtyManager::default(),
                data_dir,
                session_settings,
                endpoint,
                startup_error: (!errors.is_empty()).then(|| errors.join("; ")),
            });

            build_tray(&handle)?;

            // Autostart with Windows by default (decision D4) - release builds
            // only, so a dev build never registers its target/debug exe.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let marker = app.state::<AppState>().data_dir.join("autostart-initialised");
                if !marker.exists() {
                    let _ = app.autolaunch().enable();
                    let _ = std::fs::write(&marker, "1");
                }
            }

            if !minimized {
                show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // close button = hide to tray; Quit lives in the tray menu
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            session_spawn,
            session_write,
            session_resize,
            session_kill,
            sessions_running,
            past_sessions,
            project_folders,
            path_is_dir,
            list_dirs,
            store_load,
            store_save,
            global_hooks_set,
            attention,
            window_focused,
            tray_status,
            quit_app,
            ui_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextWire");
}
