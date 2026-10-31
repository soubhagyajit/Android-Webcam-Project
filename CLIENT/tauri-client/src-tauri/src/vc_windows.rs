// virtual - cam file
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use zune_jpeg::JpegDecoder;

static CAM_RUNNING: AtomicBool = AtomicBool::new(false);
static CAM_THREAD: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// What sender.rs hands off, depending on which source it read from.
/// MJPEG frames arrive already-encoded and still need a JPEG decode here.
/// RTSP frames arrive already-decoded (by ffmpeg) and go straight to softcam.
pub enum IncomingFrame {
    Jpeg(Vec<u8>),
    RawBgr(Vec<u8>),
}

static LATEST_FRAME: Mutex<Option<IncomingFrame>> = Mutex::new(None);

pub fn is_cam_running() -> bool {
    CAM_RUNNING.load(Ordering::Relaxed)
}

#[link(name = "softcam")]
unsafe extern "system" {
    fn scCreateCamera(width: i32, height: i32, frame_rate: f32) -> *mut c_void;
    fn scWaitForConnection(camera: *mut c_void, timeout_sec: f32) -> bool;
    fn scSendFrame(camera: *mut c_void, image_data: *const u8);
    fn scDeleteCamera(camera: *mut c_void) -> bool;
}

/// Called by sender.rs whenever it has a new frame ready, in whichever
/// form its source naturally produces. Overwrites rather than queues.
pub fn push_frame(frame: IncomingFrame) {
    *LATEST_FRAME.lock().unwrap() = Some(frame);
}

fn decode_jpeg_to_bgr(jpeg_bytes: &[u8], width: u32, height: u32, out: &mut [u8]) -> bool {
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

    for (src, dst) in pixels.chunks_exact(3).zip(out.chunks_exact_mut(3)) {
        dst[0] = src[2]; // b
        dst[1] = src[1]; // g
        dst[2] = src[0]; // r
    }

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
        let handle = std::thread::spawn(move || {
            start_cam(height, width);
        });
        *CAM_THREAD.lock().unwrap() = Some(handle);
    } else {
        CAM_RUNNING.store(false, Ordering::Relaxed);
        if let Some(handle) = CAM_THREAD.lock().unwrap().take() {
            handle.join().unwrap();
        }
    }
}

fn start_cam(height: u32, width: u32) {
    println!("Cam loop started");

    let cam = unsafe { scCreateCamera(width as i32, height as i32, 30.0) };
    unsafe { scWaitForConnection(cam, 30.0) };

    // Allocated once, reused for every frame regardless of which branch
    // below fills it — this is the "no per-frame alloc" rule from above.
    let mut bgr_scratch = vec![0u8; (width * height * 3) as usize];

    while CAM_RUNNING.load(Ordering::Relaxed) {
        let frame = LATEST_FRAME.lock().unwrap().take();
        let Some(frame) = frame else {
            thread::sleep(Duration::from_millis(5));
            continue;
        };

        match frame {
            IncomingFrame::Jpeg(jpeg_bytes) => {
                if !decode_jpeg_to_bgr(&jpeg_bytes, width, height, &mut bgr_scratch) {
                    continue;
                }
                unsafe { scSendFrame(cam, bgr_scratch.as_ptr()) };
            }
            IncomingFrame::RawBgr(bgr_bytes) => {
                // Already decoded upstream (ffmpeg) — send as-is.
                // Guard the size so a mismatched resolution can't read out of bounds.
                if bgr_bytes.len() != bgr_scratch.len() {
                    continue;
                }
                unsafe { scSendFrame(cam, bgr_bytes.as_ptr()) };
            }
        }
    }

    unsafe { scDeleteCamera(cam) };
}
