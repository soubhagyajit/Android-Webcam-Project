// sender.rs — middleman between the phone stream and vc.rs / UI preview.

use crate::vc::{cam_client_connected, is_cam_running, push_frame, IncomingFrame};
use ffmpeg_next as ff;
use ffmpeg_sys_next as ffi;
use image::{ImageFormat, RgbImage};
use serde::Deserialize;
use std::io::{Cursor, Read};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

static SENDER_RUNNING: AtomicBool = AtomicBool::new(false);
static SENDER_STOPPING: AtomicBool = AtomicBool::new(false);
static SENDER_THREAD: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static PREVIEW_FRAME_PENDING: AtomicU32 = AtomicU32::new(0);
static NEXT_PREVIEW_FRAME_ID: AtomicU32 = AtomicU32::new(1);

static HW_DECODE_ENABLED: AtomicBool = AtomicBool::new(true);
static HW_DECODE_FAILED_THIS_SESSION: AtomicBool = AtomicBool::new(false);

static mut HW_PIX_FMT: ffi::AVPixelFormat = ffi::AVPixelFormat::AV_PIX_FMT_NONE;

struct UiFrame {
    bgr_data: Vec<u8>,
    width: u32,
    height: u32,
}

fn send_preview_frame(channel: &Channel<InvokeResponseBody>, jpeg: &[u8]) {
    let frame_id = NEXT_PREVIEW_FRAME_ID.fetch_add(1, Ordering::Relaxed).max(1);
    if PREVIEW_FRAME_PENDING
        .compare_exchange(0, frame_id, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    // Prefix the binary JPEG with a small sequence id so an acknowledgement
    // from an older connection cannot release a newer frame.
    let mut payload = Vec::with_capacity(4 + jpeg.len());
    payload.extend_from_slice(&frame_id.to_le_bytes());
    payload.extend_from_slice(jpeg);
    if channel.send(InvokeResponseBody::Raw(payload)).is_err() {
        let _ = PREVIEW_FRAME_PENDING.compare_exchange(
            frame_id,
            0,
            Ordering::AcqRel,
            Ordering::Relaxed,
        );
    }
}

#[tauri::command]
pub fn preview_frame_ack(frame_id: u32) {
    let _ = PREVIEW_FRAME_PENDING.compare_exchange(
        frame_id,
        0,
        Ordering::AcqRel,
        Ordering::Relaxed,
    );
}

fn spawn_ui_encoder(channel: Channel<InvokeResponseBody>) -> SyncSender<UiFrame> {
    let (tx, rx) = sync_channel::<UiFrame>(1);

    thread::spawn(move || {
        let mut last_emit = Instant::now();

        while let Ok(frame) = rx.recv() {
            if last_emit.elapsed() < Duration::from_millis(66) {
                continue;
            }

            let mut rgb_bytes = frame.bgr_data;
            for chunk in rgb_bytes.chunks_exact_mut(3) {
                chunk.swap(0, 2);
            }

            if let Some(img_buffer) = RgbImage::from_raw(frame.width, frame.height, rgb_bytes) {
                let mut jpeg_bytes = Cursor::new(Vec::new());
                if img_buffer.write_to(&mut jpeg_bytes, ImageFormat::Jpeg).is_ok() {
                    let jpeg = jpeg_bytes.into_inner();
                    send_preview_frame(&channel, &jpeg);
                    last_emit = Instant::now();
                }
            }
        }
    });

    tx
}

#[tauri::command]
pub fn set_hw_decode_enabled(enabled: bool) {
    HW_DECODE_ENABLED.store(enabled, Ordering::Relaxed);
    println!("sender: hardware decode {}", if enabled { "enabled" } else { "disabled" });
}

#[derive(Clone, Copy, PartialEq, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamSource {
    Mjpeg,
    Rtsp,
}

#[tauri::command]
pub fn start_sender(
    source: StreamSource,
    url: String,
    on_frame: Channel<InvokeResponseBody>,
) -> bool {
    println!("sender: starting stream from {} at {}", source as u8, url);
    if SENDER_RUNNING.load(Ordering::Relaxed) || SENDER_STOPPING.load(Ordering::Acquire) {
        return false;
    }
    SENDER_RUNNING.store(true, Ordering::Relaxed);
    PREVIEW_FRAME_PENDING.store(0, Ordering::Relaxed);
    HW_DECODE_FAILED_THIS_SESSION.store(false, Ordering::Relaxed);

    let handle = thread::spawn(move || match source {
        StreamSource::Mjpeg => run_mjpeg(on_frame, url),
        StreamSource::Rtsp => run_rtsp(on_frame, url),
    });
    *SENDER_THREAD.lock().unwrap() = Some(handle);
    true
}

#[tauri::command]
pub fn stop_sender() {
    SENDER_RUNNING.store(false, Ordering::Relaxed);
    PREVIEW_FRAME_PENDING.store(0, Ordering::Relaxed);
    if SENDER_STOPPING.swap(true, Ordering::AcqRel) { return; }
    
    // FIX 1: Offload thread join to background worker so Tauri's main UI thread never blocks
    thread::spawn(|| {
        if let Some(handle) = SENDER_THREAD.lock().unwrap().take() {
            let _ = handle.join();
        }
        SENDER_STOPPING.store(false, Ordering::Release);
    });
}

// --- MJPEG path ---

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

fn read_next_jpeg(
    reader: &mut impl Read,
    buffer: &mut Vec<u8>,
    chunk: &mut [u8],
) -> Option<Vec<u8>> {
    const HEADER_MARKER: [u8; 4] = [13, 10, 13, 10];
    let header_end = loop {
        if let Some(pos) = find_marker(buffer, &HEADER_MARKER) {
            break pos;
        }
        let n = reader.read(chunk).ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
    };

    let header_text = String::from_utf8_lossy(&buffer[0..header_end]);
    let content_length: usize = header_text
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .and_then(|v| v.parse().ok())?;

    let frame_len = header_end + 4 + content_length;
    while buffer.len() < frame_len {
        let n = reader.read(chunk).ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }

    let jpeg = buffer[(header_end + 4)..frame_len].to_vec();
    buffer.drain(..frame_len);
    Some(jpeg)
}

fn run_mjpeg(on_frame: Channel<InvokeResponseBody>, url: String) {
    println!("sender: connecting to MJPEG at {url}");
    
    // FIX 2: Add socket read & connection timeouts to MJPEG HTTP client
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .connect_timeout(Duration::from_secs(3))
        .build() 
    {
        Ok(c) => c,
        Err(_) => {
            SENDER_RUNNING.store(false, Ordering::Relaxed);
            return;
        }
    };

    let Ok(mut reader) = client.get(&url).send() else {
        println!("sender: failed to connect to MJPEG source");
        SENDER_RUNNING.store(false, Ordering::Relaxed);
        return;
    };

    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16384];
    let mut last_preview_emit = Instant::now() - Duration::from_millis(66);

    while SENDER_RUNNING.load(Ordering::Relaxed) {
        let Some(jpeg) = read_next_jpeg(&mut reader, &mut buffer, &mut chunk) else {
            println!("sender: MJPEG stream ended or errored");
            break;
        };

        if is_cam_running() && cam_client_connected() {
            push_frame(IncomingFrame::Jpeg(jpeg.clone()));
        }

        // Keep the preview rate bounded; the acknowledgement also ensures at
        // most one full-size frame is in flight to the WebView.
        if last_preview_emit.elapsed() >= Duration::from_millis(66) {
            send_preview_frame(&on_frame, &jpeg);
            last_preview_emit = Instant::now();
        }
    }

    SENDER_RUNNING.store(false, Ordering::Relaxed);
}

// --- RTSP path ---

unsafe extern "C" fn get_hw_format(
    _ctx: *mut ffi::AVCodecContext,
    pix_fmts: *const ffi::AVPixelFormat,
) -> ffi::AVPixelFormat {
    let mut p = pix_fmts;
    unsafe {
        while *p != ffi::AVPixelFormat::AV_PIX_FMT_NONE {
            if *p == HW_PIX_FMT {
                return *p;
            }
            p = p.add(1);
        }
    }
    ffi::AVPixelFormat::AV_PIX_FMT_NONE
}

unsafe fn try_attach_hw(
    decoder: &mut ff::decoder::Video,
    decoder_codec: &ff::Codec,
    hwaccel_type: ffi::AVHWDeviceType,
) -> bool {
    let mut i = 0;
    let mut matched_fmt: Option<ffi::AVPixelFormat> = None;
    loop {
        let config = ffi::avcodec_get_hw_config(decoder_codec.as_ptr(), i);
        if config.is_null() {
            break;
        }
        let cfg = *config;
        if (cfg.methods & ffi::AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX as i32) != 0
            && cfg.device_type == hwaccel_type
        {
            matched_fmt = Some(cfg.pix_fmt);
            break;
        }
        i += 1;
    }

    let Some(fmt) = matched_fmt else {
        return false;
    };

    let mut hw_device_ctx: *mut ffi::AVBufferRef = ptr::null_mut();
    let ret =
        ffi::av_hwdevice_ctx_create(&mut hw_device_ctx, hwaccel_type, ptr::null(), ptr::null_mut(), 0);
    if ret < 0 {
        return false;
    }

    HW_PIX_FMT = fmt;
    let ctx_ptr = decoder.as_mut_ptr();
    (*ctx_ptr).hw_device_ctx = ffi::av_buffer_ref(hw_device_ctx);
    (*ctx_ptr).get_format = Some(get_hw_format);
    true
}

fn open_rtsp_stream(
    url: &str,
    use_hw: bool,
    hwaccel_type: ffi::AVHWDeviceType,
) -> Result<(ff::format::context::Input, usize, ff::decoder::Video), ff::Error> {
    let mut opts = ff::Dictionary::new();
    
    opts.set("rtsp_transport", "tcp");
    
    // FIX 3: 3-second socket timeout (in microseconds) so FFmpeg breaks out on drop
    opts.set("stimeout", "3000000");

    let ictx = ff::format::input_with_dictionary(url, opts)?;

    let video_stream = ictx
        .streams()
        .best(ff::media::Type::Video)
        .expect("no video stream in RTSP source");
    let video_stream_index = video_stream.index();
    let codec_params = video_stream.parameters();

    let decoder_codec =
        ff::decoder::find(codec_params.id()).expect("no H.264 decoder available");

    let context = ff::codec::context::Context::from_parameters(codec_params)?;
    let mut decoder = context.decoder().video()?;

    if use_hw {
        let attached = unsafe { try_attach_hw(&mut decoder, &decoder_codec, hwaccel_type) };
        if !attached {
            println!("sender: hw attach failed outright, using software this run");
        }
    }

    Ok((ictx, video_stream_index, decoder))
}

fn run_rtsp(on_frame: Channel<InvokeResponseBody>, url: String) {
    ff::init().expect("ffmpeg init failed");
    let hwaccel_type = ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA;

    let mut use_hw = HW_DECODE_ENABLED.load(Ordering::Relaxed)
        && !HW_DECODE_FAILED_THIS_SESSION.load(Ordering::Relaxed);

    let mut sws_ctx: Option<ff::software::scaling::Context> = None;
    let ui_tx = spawn_ui_encoder(on_frame);

    'reconnect: while SENDER_RUNNING.load(Ordering::Relaxed) {
        let (mut ictx, video_stream_index, mut decoder) =
            match open_rtsp_stream(&url, use_hw, hwaccel_type) {
                Ok(v) => v,
                Err(e) => {
                    println!("sender: failed to open RTSP stream: {e}");
                    break;
                }
            };

        println!("sender: RTSP decode running ({})", if use_hw { "hardware" } else { "software" });

        for (stream, packet) in ictx.packets() {
            if !SENDER_RUNNING.load(Ordering::Relaxed) {
                break 'reconnect;
            }
            if stream.index() != video_stream_index {
                continue;
            }

            if decoder.send_packet(&packet).is_err() {
                if use_hw {
                    println!("sender: hardware decode rejected this stream — falling back to software");
                    HW_DECODE_FAILED_THIS_SESSION.store(true, Ordering::Relaxed);
                    use_hw = false;
                    sws_ctx = None;
                    continue 'reconnect;
                } else {
                    println!("sender: software decode failed too — not a hw issue, giving up");
                    break 'reconnect;
                }
            }

            let mut decoded_frame = ff::util::frame::Video::empty();
            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                let mut sw_frame = ff::util::frame::Video::empty();
                let source_frame: &ff::util::frame::Video = if use_hw {
                    let ok = unsafe {
                        ffi::av_hwframe_transfer_data(
                            sw_frame.as_mut_ptr(),
                            decoded_frame.as_ptr(),
                            0,
                        ) >= 0
                    };
                    if !ok {
                        continue;
                    }
                    &sw_frame
                } else {
                    &decoded_frame
                };

                let (width, height) = (source_frame.width(), source_frame.height());

                if sws_ctx.is_none() {
                    sws_ctx = Some(
                        ff::software::scaling::Context::get(
                            source_frame.format(),
                            width,
                            height,
                            ff::format::Pixel::BGR24,
                            width,
                            height,
                            ff::software::scaling::Flags::BILINEAR,
                        )
                        .expect("failed to build sws scaling context"),
                    );
                }

                let mut bgr_frame = ff::util::frame::Video::empty();
                sws_ctx
                    .as_mut()
                    .unwrap()
                    .run(source_frame, &mut bgr_frame)
                    .expect("sws_scale failed");

                let bgr_bytes = bgr_frame.data(0).to_vec();

                if is_cam_running() && cam_client_connected() {
                    push_frame(IncomingFrame::RawBgr(bgr_bytes.clone()));
                }

                let _ = ui_tx.try_send(UiFrame {
                    bgr_data: bgr_bytes,
                    width,
                    height,
                });
            }
        }

        break;
    }

    SENDER_RUNNING.store(false, Ordering::Relaxed);
}
