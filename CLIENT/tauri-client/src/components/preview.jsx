import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function Preview({ phoneConnected, feedActive, cameraEnabled, cameraActive, showPreview, previewExpired, onFrameReceived, width, height, channel }) {
  const videoRef = useRef(null);
  const phoneConnectedRef = useRef(phoneConnected);
  const showPreviewRef = useRef(showPreview);
  const onFrameReceivedRef = useRef(onFrameReceived);
  const hasReportedFrameRef = useRef(false);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);

  useEffect(() => {
    phoneConnectedRef.current = phoneConnected;
  }, [phoneConnected]);

  useEffect(() => {
    showPreviewRef.current = showPreview;
    onFrameReceivedRef.current = onFrameReceived;
    if (!showPreview) {
      setHasLiveFrame(false);
      hasReportedFrameRef.current = false;
    }
  }, [showPreview, onFrameReceived]);

  useEffect(() => {
    if (!feedActive) setHasLiveFrame(false);
  }, [feedActive]);

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
        if (disposed || !phoneConnectedRef.current || !showPreviewRef.current || decoding || bytes.byteLength <= 4) {
          return;
        }
        decoding = true;
        bitmap = await createImageBitmap(
          new Blob([bytes.subarray(4)], { type: "image/jpeg" }),
        );
        if (
          !disposed &&
          phoneConnectedRef.current &&
          showPreviewRef.current &&
          videoRef.current
        ) {
          const canvas = videoRef.current;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          setHasLiveFrame(true);
          if (!hasReportedFrameRef.current) {
            hasReportedFrameRef.current = true;
            onFrameReceivedRef.current?.();
          }
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

  const placeholderTitle = previewExpired
    ? "PREVIEW PAUSED"
    : phoneConnected
      ? "CONNECTING TO PHONE"
      : cameraActive
        ? "VIRTUAL CAM STARTED"
        : "CONNECT PHONE TO START STREAMING";
  const placeholderSubtitle = previewExpired
    ? "CLICK SHOW PREVIEW FOR 30S"
    : phoneConnected
      ? "WAITING FOR PHONE FEED"
      : cameraActive
        ? "CAMERA ACTIVE - NO PHONE FEED"
        : "";

  return (
    <div
      id="videoStreamDiv"
      className={`${showPreview || cameraEnabled || previewExpired ? "flex" : "hidden"} relative w-full h-full items-center justify-center`}
    >
      <canvas
        ref={videoRef}
        id="videoStream"
        className={`${showPreview && hasLiveFrame ? "block" : "hidden"} max-w-full max-h-full rounded-2xl border border-slate-700/50 video-glow object-contain transition-all duration-500`}
        aria-label="Live camera preview"
      />
      {(!showPreview || !hasLiveFrame) && (
        <div className="absolute inset-0 flex items-center justify-center rounded-2xl border border-slate-700/50 bg-[#181818]">
          <div className="w-4/5 bg-[#1b1f2b] px-6 py-5 text-center">
            <div className="text-lg font-medium text-slate-200 sm:text-2xl">
              {placeholderTitle}
            </div>
            {placeholderSubtitle && (
              <div className="mt-2 text-sm text-blue-300 sm:text-base">
                {placeholderSubtitle}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
