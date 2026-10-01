//! Windows toasts that report clicks.
//!
//! The notification plugin cannot tell us when a toast is clicked, and the
//! `tauri-winrt-notification` helper drops the `ToastNotification` right after
//! showing it - with that object gone the `Activated` event never reaches us.
//! Here the last few toasts are kept alive, so clicking one (while it is on
//! screen or in the notification centre and the app is running) calls back.

use std::sync::Mutex;

use windows::core::{IInspectable, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

/// PowerShell's AppUserModelID - what unpackaged dev builds show toasts as.
pub const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const KEEP_LAST: usize = 20;

// only held so the toast (and its Activated handler) stays alive
struct Kept(#[allow(dead_code)] ToastNotification);
// ToastNotification is an agile WinRT object; holding it from any thread is fine.
unsafe impl Send for Kept {}

static KEPT: Mutex<Vec<Kept>> = Mutex::new(Vec::new());

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        r#"<toast activationType="foreground"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        xml_escape(title),
        xml_escape(body)
    )
}

/// Give this process the installed app's AppUserModelID. Windows routes a
/// toast click to the process whose ID matches the toast's; without this the
/// installed app's toasts would show but their clicks would not reach us.
pub fn set_process_app_id(app_id: &str) {
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id));
    }
}

pub fn show(app_id: &str, title: &str, body: &str, on_click: impl Fn() + Send + 'static) -> windows::core::Result<()> {
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
        on_click();
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)?;
    let mut kept = KEPT.lock().unwrap();
    kept.push(Kept(toast));
    let extra = kept.len().saturating_sub(KEEP_LAST);
    kept.drain(..extra);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_is_escaped() {
        let x = toast_xml("a <b> & \"c\"", "x&y");
        assert!(x.contains("a &lt;b&gt; &amp; &quot;c&quot;"));
        assert!(x.contains("<text>x&amp;y</text>"));
        let doc = XmlDocument::new().unwrap();
        doc.LoadXml(&HSTRING::from(x)).expect("valid toast xml");
    }
}
