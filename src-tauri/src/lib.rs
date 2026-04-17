// Varkitekt is a pure-frontend app — no Tauri IPC commands are exposed.
// The webview runs the HTML/JS/CSS bundle shipped in ../src.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
