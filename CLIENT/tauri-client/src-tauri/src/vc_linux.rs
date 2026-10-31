// vc_linux.rs — Pure virtual camera sink for Linux (v4l2loopback)
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use v4l::video::Output;
use v4l::{Device, FourCC, Format};
use zune_jpeg::JpegDecoder;

static CAM_RUNNING: AtomicBool = AtomicBool::new(false);
static CAM_THREAD: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// Frames pushed directly from sender.rs
pub enum IncomingFrame {
    Jpeg(Vec<u8>),
    RawBgr(Vec<u8>),
}

static LATEST_FRAME: Mutex<Option<IncomingFrame>> = Mutex::new(None);

pub fn is_cam_running() -> bool {
    CAM_RUNNING.load(Ordering::Relaxed)
}

/// Overwrites LATEST_FRAME with the latest payload sent by sender.rs
pub fn push_frame(frame: IncomingFrame) {
    *LATEST_FRAME.lock().unwrap() = Some(frame);
}

fn decode_to_rgb(jpeg_bytes: &[u8], width: u32, height: u32, out: &mut [u8]) -> bool {
    let mut decoder = JpegDecoder::new(jpeg_bytes);
    let Ok(pixels) = decoder.decode() else {
        return false;
    };
    let Some((dec_w, dec_h)) = decoder.dimensions() else {
        return false;
    };
    if dec_w as u32 != width || dec_h as u32 != height {
        return false;
    }
    out.copy_from_slice(&pixels);
    true
}

#[tauri::command]
pub fn init_cam(on: bool, height: u32, width: u32) {
    println!("Cam Init {}", on);
    if on {
        if CAM_RUNNING.load(Ordering::Relaxed) {
            return;
        }
        CAM_RUNNING.store(true, Ordering::Relaxed);
        let handle = thread::spawn(move || {
            start_cam(height, width);
        });
        *CAM_THREAD.lock().unwrap() = Some(handle);
    } else {
        CAM_RUNNING.store(false, Ordering::Relaxed);
        if let Some(handle) = CAM_THREAD.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

fn start_cam(height: u32, width: u32) {
    println!("Cam loop started (linux)");

    let mut dev = Device::with_path("/dev/video0").expect("Failed to open v4l2loopback device");

    // Use Output::format and Output::set_format explicitly to target V4L2_BUF_TYPE_VIDEO_OUTPUT.
    // This allows exclusive_caps=1 mode on v4l2loopback without returning EINVAL.
    let mut fmt = Output::format(&dev).unwrap_or_else(|_| Format::new(width, height, FourCC::new(b"RGB3")));
    fmt.width = width;
    fmt.height = height;
    fmt.fourcc = FourCC::new(b"RGB3");

    let fmt = Output::set_format(&dev, &fmt).expect("Failed to set format");
    println!("Linux vcam format in use:\n{}", fmt);

    let mut rgb_frame = vec![0u8; (width * height * 3) as usize];

    while CAM_RUNNING.load(Ordering::Relaxed) {
        let frame = LATEST_FRAME.lock().unwrap().take();
        let Some(frame) = frame else {
            thread::sleep(Duration::from_millis(5));
            continue;
        };

        match frame {
            IncomingFrame::Jpeg(jpeg_bytes) => {
                if !decode_to_rgb(&jpeg_bytes, width, height, &mut rgb_frame) {
                    continue;
                }
            }
            IncomingFrame::RawBgr(mut bgr_bytes) => {
                if bgr_bytes.len() != rgb_frame.len() {
                    continue;
                }
                // Convert BGR (from FFmpeg upstream) to RGB for v4l2loopback RGB3
                for chunk in bgr_bytes.chunks_exact_mut(3) {
                    chunk.swap(0, 2);
                }
                rgb_frame.copy_from_slice(&bgr_bytes);
            }
        }

        if let Err(e) = dev.write_all(&rgb_frame) {
            eprintln!("Failed writing frame to v4l2loopback: {:?}", e);
        }
    }
}
