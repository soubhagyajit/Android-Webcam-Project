use default_net::interface::Interface;
use futures_util::stream::{self, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SERVICE_TYPE: &str = "_awa._tcp.local.";
const HTTP_PORT: u16 = 8080;
const MDNS_WINDOW: Duration = Duration::from_secs(3);
const HTTP_PROBE_TIMEOUT: Duration = Duration::from_millis(700);
static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaDevice {
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub protocol: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFinished {
    request_id: u64,
    cancelled: bool,
    mdns_found: usize,
    fallback_used: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanDeviceFound {
    request_id: u64,
    device: AwaDevice,
}

#[derive(Deserialize)]
struct FeaturesResponse {
    resolutions: Option<Vec<String>>,
    stream_protocol: Option<String>,
    server_port: Option<u16>,
}

fn begin_scan() -> u64 {
    SCAN_GENERATION.fetch_add(1, Ordering::AcqRel) + 1
}

fn is_cancelled(generation: u64) -> bool {
    SCAN_GENERATION.load(Ordering::Acquire) != generation
}

fn add_device(
    devices: &mut Vec<AwaDevice>,
    seen_ips: &mut HashSet<String>,
    device: AwaDevice,
) -> bool {
    if !seen_ips.insert(device.ip.clone()) {
        return false;
    }
    devices.push(device);
    true
}

fn emit_device(app: &AppHandle, request_id: u64, device: &AwaDevice) {
    let _ = app.emit(
        "scan-device-found",
        ScanDeviceFound {
            request_id,
            device: device.clone(),
        },
    );
}

/// Runs entirely on a blocking worker. The daemon is shut down on every path
/// after successful construction, including browse failures and cancellation.
fn scan_mdns_blocking(
    app: Option<AppHandle>,
    generation: u64,
    request_id: u64,
) -> Result<Vec<AwaDevice>, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("Could not start mDNS: {e}"))?;
    let result = (|| {
        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| format!("Could not browse mDNS services: {e}"))?;
        let deadline = Instant::now() + MDNS_WINDOW;
        let mut devices = Vec::new();
        let mut seen = HashSet::new();

        while Instant::now() < deadline && !is_cancelled(generation) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = remaining.min(Duration::from_millis(200));
            match receiver.recv_timeout(wait) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    let Some(ip) = info.get_addresses_v4().into_iter().next() else {
                        continue;
                    };
                    let protocol = info
                        .get_property_val_str("proto")
                        .unwrap_or("MJPEG")
                        .to_owned();
                    let name = info
                        .get_fullname()
                        .strip_suffix(SERVICE_TYPE)
                        .unwrap_or(info.get_fullname())
                        .trim_end_matches('.')
                        .to_owned();
                    let device = AwaDevice {
                        name,
                        ip: ip.to_string(),
                        port: info.get_port(),
                        protocol,
                    };
                    if add_device(&mut devices, &mut seen, device.clone()) {
                        if let Some(app) = &app {
                            emit_device(app, request_id, &device);
                        }
                    }
                }
                Ok(_) => {}
                Err(mdns_sd::RecvTimeoutError::Timeout) => {}
                Err(mdns_sd::RecvTimeoutError::Disconnected) => break,
            }
        }
        Ok(devices)
    })();
    let shutdown_result = daemon.shutdown();
    if let Err(error) = shutdown_result {
        eprintln!("mDNS daemon shutdown reported an error: {error}");
    }
    result
}

#[tauri::command]
pub async fn scan_mdns() -> Result<Vec<AwaDevice>, String> {
    let generation = begin_scan();
    tauri::async_runtime::spawn_blocking(move || scan_mdns_blocking(None, generation, 0))
        .await
        .map_err(|e| format!("mDNS worker failed: {e}"))?
}

fn default_route_ipv4() -> Result<Ipv4Addr, String> {
    let interface = Interface::default()
        .map_err(|e| format!("Could not find the default network adapter: {e}"))?;
    interface
        .ipv4
        .iter()
        .map(|network| network.addr)
        .find(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local())
        .ok_or_else(|| "The default network adapter has no active IPv4 address".to_owned())
}

fn subnet_hosts(local_ip: Ipv4Addr) -> Vec<Ipv4Addr> {
    let octets = local_ip.octets();
    let hotspot = Ipv4Addr::new(192, 168, 43, 1);
    let mut hosts = Vec::with_capacity(254);
    for host in 1..=254 {
        let ip = Ipv4Addr::new(octets[0], octets[1], octets[2], host);
        if ip != local_ip && ip != hotspot {
            hosts.push(ip);
        }
    }
    hosts.insert(0, hotspot);
    hosts
}

async fn probe_host(client: &reqwest::Client, ip: Ipv4Addr) -> Option<AwaDevice> {
    let url = format!("http://{ip}:{HTTP_PORT}/features");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let features: FeaturesResponse = response.json().await.ok()?;
    if features.resolutions.is_none() {
        return None;
    }
    let protocol = features.stream_protocol?;
    Some(AwaDevice {
        name: format!("AWA device ({ip})"),
        ip: ip.to_string(),
        port: features.server_port.unwrap_or(HTTP_PORT),
        protocol,
    })
}

async fn scan_subnet_inner(
    app: Option<AppHandle>,
    generation: u64,
    request_id: u64,
) -> Result<Vec<AwaDevice>, String> {
    let local_ip = default_route_ipv4()?;
    let client = reqwest::Client::builder()
        .timeout(HTTP_PROBE_TIMEOUT)
        .build()
        .map_err(|e| format!("Could not create HTTP discovery client: {e}"))?;
    let mut hosts = subnet_hosts(local_ip).into_iter();
    let mut devices = Vec::new();
    let mut seen = HashSet::new();

    // Probe the common Android hotspot address before the subnet sweep.
    if !is_cancelled(generation) {
        if let Some(hotspot) = hosts.next() {
            if let Some(device) = probe_host(&client, hotspot).await {
                if add_device(&mut devices, &mut seen, device.clone()) {
                    if let Some(app) = &app {
                        emit_device(app, request_id, &device);
                    }
                }
            }
        }
    }

    let mut results = stream::iter(hosts.map(|ip| {
        let client = client.clone();
        async move { probe_host(&client, ip).await }
    }))
    .buffer_unordered(64);

    while let Some(device) = results.next().await {
        if is_cancelled(generation) {
            break;
        }
        if let Some(device) = device {
            if add_device(&mut devices, &mut seen, device.clone()) {
                if let Some(app) = &app {
                    emit_device(app, request_id, &device);
                }
            }
        }
    }
    Ok(devices)
}

#[tauri::command]
pub async fn scan_subnet() -> Result<Vec<AwaDevice>, String> {
    let generation = begin_scan();
    scan_subnet_inner(None, generation, 0).await
}

#[tauri::command]
pub fn cancel_device_scan() {
    begin_scan();
}

#[tauri::command]
pub async fn discover_devices(app: AppHandle, request_id: u64) -> Result<Vec<AwaDevice>, String> {
    let generation = begin_scan();
    let _ = app.emit("scan-started", request_id);

    let mdns_app = app.clone();
    let mdns = tauri::async_runtime::spawn_blocking(move || {
        scan_mdns_blocking(Some(mdns_app), generation, request_id)
    })
    .await;

    let (mut devices, mdns_error) = match mdns {
        Ok(Ok(devices)) => (devices, None),
        Ok(Err(error)) => (Vec::new(), Some(error)),
        Err(error) => (Vec::new(), Some(format!("mDNS worker failed: {error}"))),
    };
    let mdns_found = devices.len();
    let mut seen: HashSet<String> = devices.iter().map(|d| d.ip.clone()).collect();
    let mut fallback_used = false;
    let mut error = mdns_error;

    if devices.is_empty() && !is_cancelled(generation) {
        fallback_used = true;
        match scan_subnet_inner(Some(app.clone()), generation, request_id).await {
            Ok(found) => {
                for device in found {
                    add_device(&mut devices, &mut seen, device);
                }
            }
            Err(sweep_error) => {
                error = Some(match error {
                    Some(mdns_error) => format!("{mdns_error}; subnet scan: {sweep_error}"),
                    None => sweep_error,
                });
            }
        }
    }

    let _ = app.emit(
        "scan-finished",
        ScanFinished {
            request_id,
            cancelled: is_cancelled(generation),
            mdns_found,
            fallback_used,
            error,
        },
    );
    Ok(devices)
}
