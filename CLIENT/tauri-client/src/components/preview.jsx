import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function Preview({ phoneConnected, feedActive, cameraEnabled, width, height, channel }) {
  const videoRef = useRef(null);
  const phoneConnectedRef = useRef(phoneConnected);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);

  useEffect(() => {
    phoneConnectedRef.current = phoneConnected;
  }, [phoneConnected]);

  useEffect(() => {
    if (!feedActive) setHasLiveFrame(false);
  }, [feedActive]);

  useEffect(() => {
    if (!cameraEnabled || hasLiveFrame || !videoRef.current) return;
    const canvas = videoRef.current;
    canvas.width = Math.max(1, width || 1280);
    canvas.height = Math.max(1, height || 720);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const unit = Math.min(canvas.width, canvas.height);
    const panelHeight = Math.floor(unit * 0.2);
    ctx.fillStyle = "#1b1f2b";
    ctx.fillRect(canvas.width * 0.1, (canvas.height - panelHeight) / 2, canvas.width * 0.8, panelHeight);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const titleSize = Math.max(12, Math.floor(unit * 0.044));
    const subtitleSize = Math.max(10, Math.floor(unit * 0.027));
    ctx.font = `500 ${titleSize}px Arial, sans-serif`;
    ctx.fillStyle = "#dce1ee";
    ctx.fillText("CAMERA ACTIVE", canvas.width / 2, canvas.height / 2 - titleSize * 0.65, canvas.width * 0.76);
    ctx.font = `400 ${subtitleSize}px Arial, sans-serif`;
    ctx.fillStyle = "#82a5e6";
    ctx.fillText("WAITING FOR PHONE FEED", canvas.width / 2, canvas.height / 2 + titleSize * 0.75, canvas.width * 0.76);
  }, [cameraEnabled, hasLiveFrame, width, height]);

  useEffect(() => {
    let decoding = false;
    let disposed = false;

    channel.onmessage = async (buffer) => {
      const bytes = buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const frameId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getUint32(0, true);
      let bitmap;

      try {
        if (disposed || !phoneConnectedRef.current || decoding || bytes.byteLength <= 4) {
          return;
        }
        decoding = true;
        bitmap = await createImageBitmap(
          new Blob([bytes.subarray(4)], { type: "image/jpeg" }),
        );
        if (!disposed && phoneConnectedRef.current && videoRef.current) {
          const canvas = videoRef.current;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          setHasLiveFrame(true);
        }
      } catch (error) {
        console.error("Failed to render preview frame:", error);
      } finally {
        bitmap?.close();
        decoding = false;
        try {
          await invoke("preview_frame_ack", { frameId });
        } catch (error) {
          console.error("Failed to acknowledge preview frame:", error);
        }
      }
    };

    return () => {
      disposed = true;
      channel.onmessage = null;
      if (videoRef.current) {
        videoRef.current.width = 0;
        videoRef.current.height = 0;
      }
    };
  }, [channel]);

  return (
    <div
      id="videoStreamDiv"
      className={`${feedActive || cameraEnabled ? "flex" : "hidden"} relative w-full h-full items-center justify-center`}
    >
      <canvas
        ref={videoRef}
        id="videoStream"
        className="max-w-full max-h-full rounded-2xl border border-slate-700/50 video-glow object-contain transition-all duration-500"
        aria-label="Live camera preview"
      />
    </div>
  );
}
