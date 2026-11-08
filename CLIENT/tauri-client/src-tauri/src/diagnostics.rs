use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn write_diagnostic_log(app: AppHandle, message: String) -> Result<String, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create log directory: {error}"))?;

    let path = directory.join("virtual-camera-diagnostics.log");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Could not open diagnostic log: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    writeln!(file, "{timestamp} {message}")
        .map_err(|error| format!("Could not write diagnostic log: {error}"))?;

    Ok(path.to_string_lossy().into_owned())
}
