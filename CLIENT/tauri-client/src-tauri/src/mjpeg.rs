// mjpeg.rs — reads the phone's MJPEG stream (`multipart/x-mixed-replace`)
// and turns it into whole JPEG frames.
//
// This file deliberately knows nothing about Tauri, ffmpeg or the virtual
// camera: sender.rs owns the stop flag and decides what to do with each frame.
// That keeps it testable against a fake phone server.
//
// Why async instead of reqwest::blocking: the blocking client can't put a
// timeout on a single read (only on the whole request, which would cut a
// long-lived stream), so a phone that went silent left the sender thread
// stuck inside `read()` forever. That also wedged `stop_sender` (its join
// never finished) and every later `start_sender`. Here every wait is bounded
// by POLL_INTERVAL, so Stop is honoured promptly and a dead feed is detected.

use std::io;
use std::time::{Duration, Instant};

/// How often the loop wakes while the phone is silent to check for Stop.
/// This is the worst-case Stop latency; while frames flow, Stop is instant.
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Give up if the phone sends nothing at all for this long mid-stream.
pub const STALL_LIMIT: Duration = Duration::from_secs(5);
/// The phone only answers `/video` once its camera is bound, which can take a
/// few seconds, so waiting for the response headers gets a longer budget.
pub const HEADERS_LIMIT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, PartialEq)]
pub enum MjpegEnd {
    /// `running()` turned false.
    Stopped,
    /// The phone closed the stream cleanly.
    Ended,
    /// Connect failure, read error, bad data, or a stalled feed.
    Failed(String),
}

/// Connects to `url` and calls `on_jpeg` for every complete frame until the
/// stream ends, fails, stalls, or `running()` returns false. The connection is
/// closed when this returns, so the phone sees the viewer leave right away.
pub async fn run_session(
    url: &str,
    running: impl Fn() -> bool,
    mut on_jpeg: impl FnMut(Vec<u8>),
) -> MjpegEnd {
    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return MjpegEnd::Failed(format!("could not create MJPEG client: {error}")),
    };

    // Wait for the response headers, but keep checking for Stop while waiting.
    let mut request = Box::pin(client.get(url).send());
    let started = Instant::now();
    let mut response = loop {
        match tokio::time::timeout(POLL_INTERVAL, &mut request).await {
            Ok(Ok(response)) => match response.error_for_status() {
                Ok(response) => break response,
                Err(error) => return MjpegEnd::Failed(format!("MJPEG connect failed: {error}")),
            },
            Ok(Err(error)) => return MjpegEnd::Failed(format!("MJPEG connect failed: {error}")),
            Err(_) => {
                if !running() {
                    return MjpegEnd::Stopped;
                }
                if started.elapsed() >= HEADERS_LIMIT {
                    return MjpegEnd::Failed(
                        "phone did not start sending video in time".to_string(),
                    );
                }
            }
        }
    };

    let mut buffer: Vec<u8> = Vec::new();
    let mut last_data = Instant::now();
    loop {
        if !running() {
            return MjpegEnd::Stopped;
        }

        // Hand over every frame that is already fully buffered first.
        match take_next_jpeg(&mut buffer) {
            Ok(Some(jpeg)) => {
                on_jpeg(jpeg);
                continue;
            }
            Ok(None) => {}
            Err(error) => return MjpegEnd::Failed(format!("MJPEG read failed: {error}")),
        }

        match tokio::time::timeout(POLL_INTERVAL, response.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                buffer.extend_from_slice(&bytes);
                last_data = Instant::now();
            }
            Ok(Ok(None)) => return MjpegEnd::Ended,
            Ok(Err(error)) => return MjpegEnd::Failed(format!("MJPEG read failed: {error}")),
            Err(_) => {
                if last_data.elapsed() >= STALL_LIMIT {
                    return MjpegEnd::Failed(format!(
                        "MJPEG stalled: no data for {}s",
                        STALL_LIMIT.as_secs()
                    ));
                }
            }
        }
    }
}

fn find_marker(buffer: &[u8], marker: &[u8]) -> Option<usize> {
    if buffer.len() < marker.len() {
        return None;
    }
    for i in 0..=(buffer.len() - marker.len()) {
        if buffer[i..i + marker.len()] == *marker {
            return Some(i);
        }
    }
    None
}

/// Removes and returns the next complete JPEG part from `buffer`, or `None`
/// if it hasn't fully arrived yet.
fn take_next_jpeg(buffer: &mut Vec<u8>) -> io::Result<Option<Vec<u8>>> {
    const HEADER_MARKER: [u8; 4] = [13, 10, 13, 10];
    let Some(header_end) = find_marker(buffer, &HEADER_MARKER) else {
        return Ok(None);
    };

    let header_text = String::from_utf8_lossy(&buffer[0..header_end]);
    let content_length: usize = header_text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "MJPEG part has no valid Content-Length",
            )
        })?;

    let frame_len = header_end + 4 + content_length;
    if buffer.len() < frame_len {
        return Ok(None);
    }

    let jpeg = buffer[(header_end + 4)..frame_len].to_vec();
    buffer.drain(..frame_len);
    Ok(Some(jpeg))
}
