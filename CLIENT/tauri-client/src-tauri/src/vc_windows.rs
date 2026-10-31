// virtual - cam file
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
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

#[tauri::command]
pub fn cam_client_connected() -> bool {
    if !CAM_RUNNING.load(Ordering::Relaxed) { return false; }
    // Softcam reports client presence from the camera handle; the loop owns
    // that handle, so publish its latest observation atomically.
    CAM_CLIENT_CONNECTED.load(Ordering::Relaxed)
}

static CAM_CLIENT_CONNECTED: AtomicBool = AtomicBool::new(false);

#[link(name = "softcam")]
unsafe extern "system" {
    fn scCreateCamera(width: i32, height: i32, frame_rate: f32) -> *mut c_void;
    fn scIsConnected(camera: *mut c_void) -> bool;
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

// Small embedded 5x7 font keeps the idle card self-contained and available
// even when the phone is disconnected or the stream has failed.
fn glyph(c: u8) -> [u8; 7] {
    match c {
        b'A' => [14,17,17,31,17,17,17], b'B' => [30,17,17,30,17,17,30],
        b'C' => [14,17,16,16,16,17,14], b'D' => [30,17,17,17,17,17,30],
        b'E' => [31,16,16,30,16,16,31], b'F' => [31,16,16,30,16,16,16],
        b'G' => [14,17,16,23,17,17,15], b'H' => [17,17,17,31,17,17,17],
        b'I' => [14,4,4,4,4,4,14], b'J' => [7,2,2,2,18,18,12],
        b'K' => [17,18,20,24,20,18,17], b'L' => [16,16,16,16,16,16,31],
        b'M' => [17,27,21,21,17,17,17], b'N' => [17,25,21,19,17,17,17],
        b'O' => [14,17,17,17,17,17,14], b'P' => [30,17,17,30,16,16,16],
        b'Q' => [14,17,17,17,21,18,13], b'R' => [30,17,17,30,20,18,17],
        b'S' => [15,16,16,14,1,1,30], b'T' => [31,4,4,4,4,4,4],
        b'U' => [17,17,17,17,17,17,14], b'V' => [17,17,17,17,17,10,4],
        b'W' => [17,17,17,21,21,21,10], b'X' => [17,17,10,4,10,17,17],
        b'Y' => [17,17,10,4,4,4,4], b'Z' => [31,1,2,4,8,16,31],
        b'0' => [14,17,19,21,25,17,14], b'1' => [4,12,4,4,4,4,14],
        b'2' => [14,17,1,2,4,8,31], b'3' => [30,1,1,14,1,1,30],
        b'4' => [2,6,10,18,31,2,2], b'5' => [31,16,16,30,1,1,30],
        b'6' => [14,16,16,30,17,17,14], b'7' => [31,1,2,4,8,8,8],
        b'8' => [14,17,17,14,17,17,14], b'9' => [14,17,17,15,1,1,14],
        b'-' => [0,0,0,31,0,0,0], b':' => [0,4,4,0,4,4,0], _ => [0; 7],
    }
}

fn draw_text(frame: &mut [u8], width: u32, height: u32, text: &str, scale: u32, y: u32, color: [u8; 3]) {
    let char_w = 6 * scale;
    let text_w = text.len() as u32 * char_w - scale;
    let mut x = width.saturating_sub(text_w) / 2;
    for c in text.bytes() {
        for (gy, row) in glyph(c.to_ascii_uppercase()).iter().enumerate() {
            for gx in 0..5 {
                if row & (1 << (4 - gx)) != 0 {
                    for sy in 0..scale { for sx in 0..scale {
                        let px=x+gx*scale+sx; let py=y+gy as u32*scale+sy;
                        if px<width && py<height { let i=((py*width+px)*3) as usize; frame[i..i+3].copy_from_slice(&color); }
                    }}
                }
            }
        }
        x += char_w;
    }
}

fn idle_frame(width: u32, height: u32) -> Vec<u8> {
    let mut frame=vec![0x18; (width * height * 3) as usize];
    for y in height/2-((height/5).min(70))..height/2+((height/5).min(70)) {
        for x in width/10..width-width/10 { let i=((y*width+x)*3) as usize; frame[i..i+3].copy_from_slice(&[27,31,43]); }
    }
    let scale=(width.min(height)/180).clamp(1,5);
    draw_text(&mut frame,width,height,"AWC VIRTUAL CAM NOT ACTIVE",scale,height/2-8*scale,[220,225,238]);
    draw_text(&mut frame,width,height,"CONNECT PHONE IN AWC",scale,height/2+2*scale,[130,165,230]);
    frame
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
    if cam.is_null() {
        eprintln!("softcam: failed to create virtual camera");
        CAM_RUNNING.store(false, Ordering::Relaxed);
        return;
    }

    // Allocated once, reused for every frame regardless of which branch
    // below fills it — this is the "no per-frame alloc" rule from above.
    let mut bgr_scratch = vec![0u8; (width * height * 3) as usize];

    let idle = idle_frame(width, height);
    let mut last_frame_at = Instant::now();
    let mut last_real_frame_at: Option<Instant> = None;
    let mut connected = false;
    while CAM_RUNNING.load(Ordering::Relaxed) {
        let now_connected = unsafe { scIsConnected(cam) };
        let just_connected = now_connected && !connected;
        if now_connected && !connected { println!("softcam: client connected"); }
        if !now_connected && connected { println!("softcam: client disconnected"); }
        connected = now_connected;
        CAM_CLIENT_CONNECTED.store(now_connected, Ordering::Relaxed);
        if just_connected { last_frame_at = Instant::now() - Duration::from_millis(33); }
        if !now_connected {
            LATEST_FRAME.lock().unwrap().take();
            thread::sleep(Duration::from_millis(20));
            continue;
        }
        let frame = LATEST_FRAME.lock().unwrap().take();
        let Some(frame) = frame else {
            if now_connected && last_frame_at.elapsed() >= Duration::from_millis(33) {
                let output = if last_real_frame_at
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
                {
                    bgr_scratch.as_slice()
                } else {
                    idle.as_slice()
                };
                unsafe { scSendFrame(cam, output.as_ptr()) };
                last_frame_at = Instant::now();
            }
            thread::sleep(Duration::from_millis(5));
            continue;
        };

        match frame {
            IncomingFrame::Jpeg(jpeg_bytes) => {
                if !decode_jpeg_to_bgr(&jpeg_bytes, width, height, &mut bgr_scratch) {
                    continue;
                }
                unsafe { scSendFrame(cam, bgr_scratch.as_ptr()) };
                last_frame_at = Instant::now();
                last_real_frame_at = Some(last_frame_at);
            }
            IncomingFrame::RawBgr(bgr_bytes) => {
                // Already decoded upstream (ffmpeg) — send as-is.
                // Guard the size so a mismatched resolution can't read out of bounds.
                if bgr_bytes.len() != bgr_scratch.len() {
                    continue;
                }
                unsafe { scSendFrame(cam, bgr_bytes.as_ptr()) };
                last_frame_at = Instant::now();
                last_real_frame_at = Some(last_frame_at);
            }
        }
    }

    unsafe { scDeleteCamera(cam) };
    CAM_CLIENT_CONNECTED.store(false, Ordering::Relaxed);
}
