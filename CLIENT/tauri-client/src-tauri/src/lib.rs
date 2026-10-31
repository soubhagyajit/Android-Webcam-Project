// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod installer;
mod adb;
mod sender;

#[cfg(target_os = "windows")]
#[path = "vc_windows.rs"]
mod vc;

#[cfg(target_os = "linux")]
#[path = "vc_linux.rs"]
mod vc;

// #[tauri::command]
// fn greet(name: &str) -> String {
//     format!("Hello, {}! You've been greeted from Rust!", name)
// }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            installer::init_installer, 
            adb::adb_get_devices, 
            adb::adb_connect_device, 
            vc::init_cam, 
            vc::cam_client_connected,
            sender::set_hw_decode_enabled, 
            sender::start_sender, 
            sender::stop_sender,
            sender::preview_frame_ack])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
