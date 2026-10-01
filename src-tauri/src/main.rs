// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `ContextWire.exe --hook` = Claude Code hook client: forward the event and
    // exit at once, without starting the GUI.
    if std::env::args().nth(1).as_deref() == Some("--hook") {
        std::process::exit(contextwire_lib::hook::run_client());
    }
    contextwire_lib::run()
}
