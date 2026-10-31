import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function Preview({ isConnected, channel }) {
  const videoRef = useRef(null);
  const isConnectedRef = useRef(isConnected);

  useEffect(() => {
    isConnectedRef.current = isConnected;
    if (!isConnected && videoRef.current) {
      videoRef.current.width = 0;
      videoRef.current.height = 0;
    }
  }, [isConnected]);

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
        if (disposed || !isConnectedRef.current || decoding || bytes.byteLength <= 4) {
          return;
        }
        decoding = true;
        bitmap = await createImageBitmap(
          new Blob([bytes.subarray(4)], { type: "image/jpeg" }),
        );
        if (!disposed && isConnectedRef.current && videoRef.current) {
          const canvas = videoRef.current;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
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
      className={`${
        isConnected ? "block" : "hidden"
      } relative w-full h-full flex items-center justify-center`}
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
