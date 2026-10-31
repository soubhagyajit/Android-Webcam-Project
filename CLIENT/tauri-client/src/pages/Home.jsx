import "../App.css";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import Preview from "../components/preview";

function Home() {
  //app-version
  const [appVersion, setAppVersion] = useState("");

  // connection settings
  // USB is temporarily the only enabled connection mode.
  const mode = "usb";
  const [phoneIP, setPhoneIP] = useState("localhost");

  const [streamProtocol, setStreamProtocol] = useState("mjpeg");
  const [httpPort, setHttpPort] = useState("8080");
  const [rtspPort, setRtspPort] = useState("8554");
  const [serverURL, setServerURL] = useState(`http://${phoneIP}:${httpPort}`);
  const [syncInterval, setSyncInterval] = useState(3000);

  // connection states and indicators
  const [toast, setToast] = useState({
    message: "",
    isError: false,
    visible: false,
  });
  const [status, setStatus] = useState({
    message: "Ready to connect.",
    state: "idle",
  });
  const [isConnected, setIsConnected] = useState(false);
  const [modeIndicator, setModeIndicator] = useState("standby");
  const [vc, setVc] = useState(false);

  // UI states
  const [connectButtonText, setConnectButtonText] = useState("Connect");
  const [connectButtonDisable, setConnectButtonDisable] = useState(false);

  //devices
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  // settings
  const [deviceFeatures, setDeviceFeatures] = useState(null);
  const [deviceSettings, setDeviceSettings] = useState({
    focus_mode: 0,
    focus_distance: 0,
    exposure_index: 1,
    zoom: 1.0,
    stream_quality: 100,
    resolution_str: "1280x720",
    camera: "back",
  });

  const [virtualCamActive, setVirtualCamActive] = useState(false);
  const [streamData, setStreamData] = useState({ width: 720, height: 1280 });

  const [showControls, setShowControls] = useState(false);
  const [resolutions, setResolutions] = useState([]);
  const [camera, setCamera] = useState("back");
  const [isFlashOn, setFlashOn] = useState(false);
  const [manualFocus, setManualFocus] = useState(false);
  const [focusMode, setFocusMode] = useState("0");
  const [manualFocusValue, setManualFocusValue] = useState(0);
  const [exposure, setExposure] = useState({
    value: 0,
    min: 0,
    max: 0,
    disabled: true,
  });

  const previewChannel = useRef(null);
  if (!previewChannel.current) previewChannel.current = new Channel();
  const syncSettingsInterval = useRef(null);
  const syncFeaturesInterval = useRef(null);
  const debounceRef = useRef(null);

  // Tracking interaction state via refs to avoid stale closures in setInterval
  const isDraggingFocus = useRef(false);
  const isDraggingExposure = useRef(false);

  const toastDiv = document.getElementById("toast");

  useEffect(() => {
    getVersion().then((v) => {
      setAppVersion(v);
      getCurrentWindow().setTitle(`AWC v${v}`);
    });
  }, []);

  useEffect(() => {
    const urlInput = document.getElementById("serverURL");
    if (mode === "usb") {
      urlInput.classList.replace("flex", "hidden");
      setPhoneIP("127.0.0.1");
      setHttpPort("8080");
      handleGetDevices();
    /* Wi-Fi mode is temporarily disabled; restore this branch with the selector.
    } else if (mode === "wifi") {
      urlInput.classList.replace("hidden", "flex");
      setPhoneIP("192.168.31.12");
      setHttpPort("8080");
    }
    */
  }, [mode]);

  useEffect(() => {
    setServerURL(`http://${phoneIP}:${httpPort}`);
  }, [phoneIP, httpPort]);

  useEffect(() => {
    if (!isConnected) return;

    // Only update local UI state if the user is not actively dragging the sliders
    if (!isDraggingFocus.current) {
      setManualFocusValue(deviceSettings.focus_distance);
    }
    if (!isDraggingExposure.current) {
      setExposure((e) => ({ ...e, value: deviceSettings.exposure_index }));
    }
    setFocusMode(deviceSettings.focus_mode.toString());
  }, [deviceSettings, deviceFeatures, isConnected]);

  useEffect(() => {
    handleResolution();
  }, [deviceSettings.resolution_str]);

  useEffect(() => {
    const applyResolutionChange = async () => {
      if (vc) {
        await invoke("init_cam", {
          on: false,
          height: streamData.height,
          width: streamData.width,
        });
        await invoke("init_cam", {
          on: true,
          height: streamData.height,
          width: streamData.width,
        });
      }
    };
    applyResolutionChange();
  }, [streamData.width, streamData.height]);

  const handleGetDevices = async () => {
    setDevicesLoading(true);
    let devices = await invoke("adb_get_devices");
    setDevices(devices);
    setDevicesLoading(false);
  };

  const handleDeviceSelect = async (e) => {
    setDevicesLoading(true);
    const device = devices.find((device) => device.id === e.target.value);
    let res = await invoke("adb_connect_device", {
      deviceId: device.id,
      deviceModel: device.model,
    });
    showToast(res, false);
    setDevicesLoading(false);
  };

  const handleVC = async () => {
    let i = vc;
    setVc(!i);
    if (i === false) {
      await invoke("init_cam", {
        on: !i,
        height: streamData.height,
        width: streamData.width,
      });
    } else {
      await invoke("init_cam", {
        on: !i,
        height: streamData.height,
        width: streamData.width,
      });
    }
  };

  const showToast = (message, isError = false) => {
    setToast({ message, isError, visible: true });
    setTimeout(() => setToast((t) => ({ ...t, visible: false })), 3000);
  };

  const updateStatus = (message, state = "idle") => {
    setStatus({ message, state });
  };

  const handleToggle = () => {
    if (isConnected) {
      handleDisconnect();
    } else {
      handleConnect();
    }
  };

  const handleConnect = async () => {
    setConnectButtonDisable(true);
    setConnectButtonText("Connecting...");
    updateStatus("Querying device features...", "idle");

    try {
      const response = await fetchUrl(`http://${phoneIP}:${httpPort}/features`);
      const features = await response.json();

      setStreamProtocol("mjpeg");
      let targetUrl = `http://${phoneIP}:${httpPort}/video`;
      const isRtsp =
        features.stream_protocol && features.stream_protocol.includes("RTSP");

      if (isRtsp) {
        setStreamProtocol("rtsp");
        setRtspPort(features.stream_port || rtspPort);
        targetUrl = `rtsp://${phoneIP}:${rtspPort}`;
      }

      updateStatus(
        `Starting ${streamProtocol.toUpperCase()} stream...`,
        "idle",
      );

      await invoke("start_sender", {
        source: streamProtocol,
        url: targetUrl,
        onFrame: previewChannel.current,
      });

      setIsConnected(true);
      setShowControls(true);
      setConnectButtonDisable(false);
      setConnectButtonText("Disconnect");
      setModeIndicator("streaming");
      updateStatus(`Feed Live (${streamProtocol.toUpperCase()})`, "active");

      if (features.resolutions) {
        setResolutions(features.resolutions);
      }

      // 4. Start background settings/features sync interval
      await initializeDeviceSync();
    } catch (err) {
      console.error("Failed to fetch features or connect:", err);
      updateStatus("Connection failed", "error");
      handleDisconnect();
    }
  };

  const handleDisconnect = async () => {
    setIsConnected(false);
    setConnectButtonDisable(false);
    setConnectButtonText("Connect");
    setShowControls(false);

    // Tell sender.rs to stop
    await invoke("stop_sender");

    if (syncSettingsInterval.current || syncFeaturesInterval.current) {
      clearInterval(syncSettingsInterval.current);
      clearInterval(syncFeaturesInterval.current);
      syncSettingsInterval.current = null;
      syncFeaturesInterval.current = null;
    }

    updateStatus("Disconnected", "idle");
  };
  const initializeDeviceSync = async () => {
    await fetchFeatures();
    await fetchSettings();
    if (syncInterval !== 0 && !syncSettingsInterval.current) {
      syncSettingsInterval.current = setInterval(() => {
        // Pause fetching settings while the user is actively using the sliders
        if (!isDraggingFocus.current && !isDraggingExposure.current) {
          fetchSettings();
        }
      }, syncInterval);
      syncFeaturesInterval.current = setInterval(fetchFeatures, syncInterval);
    }
  };

  const fetchFeatures = async () => {
    const base = serverURL;
    if (!base) return;

    try {
      const response = await fetchUrl(`${base}/features`);
      if (!response.ok) throw new Error("Failed to fetch features");

      const features = await response.json();
      setDeviceFeatures(features);
      setResolutions(features.resolutions);
      setManualFocus(features.manual_focus);
      if (
        features.exposure_lower !== undefined &&
        features.exposure_upper !== undefined
      ) {
        setExposure((e) => ({
          ...e,
          min: features.exposure_lower,
          max: features.exposure_upper,
          disabled: features.exposure_lower === features.exposure_upper,
        }));
      }
    } catch (err) {
      console.error("Failed to fetch features:", err);
      showToast("Could not load device features", true);
    }
  };

  const fetchSettings = async () => {
    const base = serverURL;
    if (!base) return;

    try {
      const response = await fetchUrl(`${base}/settings`);
      if (!response.ok) throw new Error("Failed to fetch settings");

      const settings = await response.json();
      setDeviceSettings(settings);
      setCamera(settings.camera);
    } catch (err) {
      console.error("Failed to fetch settings:", err);
    }
  };

  const sendControl = async (
    query,
    msg = "Command Send",
    type,
    value = null,
  ) => {
    const base = serverURL;
    if (!base) return;
    try {
      const response = await fetchUrl(`${base}/control?${query}`);
      if (response.ok) {
        showToast(msg);
      }
      // Removed initializeDeviceSync() call here to prevent duplicate interval execution
    } catch (err) {
      console.error("Control failed", err);
      showToast("Command failed", true);
    }
  };

  const sendControlDebounced = (query, msg) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      sendControl(query, msg);
    }, 100);
  };

  const handleFocusChange = (e) => {
    const val = e.target.value;
    setManualFocusValue(val);
    sendControlDebounced(
      `focus_mode=1&focus_distance=${val}`,
      `Focus Distance: ${val}`,
    );
  };

  const handleExposureChange = (e) => {
    const val = e.target.value;
    setExposure((prev) => ({ ...prev, value: val }));
    sendControlDebounced(`exposure_index=${val}`, `Exposure: ${val}`);
  };

  const handleResolution = () => {
    if (!deviceSettings.resolution_str) return;
    const [width, height] = deviceSettings.resolution_str
      .split("x")
      .map(Number);
    setStreamData((e) => ({
      ...e,
      width: width,
      height: height,
    }));
  };

  const handleSwitchCamera = () => {
    const newValue = camera === "back" ? true : false;
    setCamera(newValue ? "front" : "back");
    sendControl(
      `camera=${newValue ? "front" : "back"}`,
      `Camera: ${newValue ? "Front" : "Back"}`,
      "camera",
      newValue,
    );
  };

  const handleFlash = () => {
    setFlashOn(!isFlashOn);
    sendControl(`flash=${!isFlashOn}`);
  };

  const fetchUrl = async (url, { timeoutMs = 3000, ...options } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  return (
    <>
      <div className="flex h-screen bg-slate-950 text-slate-200">
        {/* Sidebar */}
        <aside className="w-80 glass border-r border-slate-800 p-6 flex flex-col gap-6 z-10 overflow-y-auto">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-brand-500 rounded-xl flex items-center justify-center shadow-lg shadow-brand-500/20">
              <svg
                className="w-6 h-6 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              AWC{" "}
              <span className="text-[10px] font-medium px-2 py-0.5 bg-slate-800 rounded-full text-slate-400 align-middle ml-1">
                v{appVersion}
              </span>
            </h1>
          </div>

          <hr className="border-slate-800" />

          <div className="space-y-4">
            <div className="space-y-2">
              {mode === "usb" && (
                <>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Select Your Device:
                  </label>
                  <div className="flex gap-2 items-center">
                    <select
                      id="selectDevice"
                      onChange={(e) => {
                        handleDeviceSelect(e);
                      }}
                      className="w-full bg-slate-800/50 border border-slate-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
                    >
                      {devices.length > 0 ? (
                        <>
                          <option value="">Select a device</option>
                          {devices.map((device) => (
                            <option key={device.id} value={device.id}>
                              {device.model}
                            </option>
                          ))}
                        </>
                      ) : (
                        <option value="">No devices available</option>
                      )}
                    </select>
                    <button
                      onClick={() => {
                        setDevices([]);
                        handleGetDevices();
                      }}
                      className="text-xs text-brand-400 hover:text-brand-300 bg-slate-800 hover:bg-slate-700 p-2 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <svg
                        className={`w-[1.4rem] h-[1.4rem] p-1 ${devicesLoading ? "animate-spin" : ""}`}
                        viewBox="0 0 16 16"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path fill="none" d="M0 0h16v16H0z" />
                        <path
                          fill="white"
                          d="M14 0v2.709A7.98 7.98 0 0 0 8 0C3.581 0 0 3.581 0 8s3.581 8 8 8 8-3.581 8-8h-2c0 1.603-.625 3.109-1.756 4.244S9.603 14 8 14s-3.109-.625-4.244-1.756C2.625 11.109 2 9.603 2 8s.625-3.109 1.756-4.244A5.97 5.97 0 0 1 8 2a5.97 5.97 0 0 1 4.472 2H10v2h6V0z"
                        />
                      </svg>
                    </button>
                  </div>
                </>
              )}
              {/* Temporarily disabled: USB/Wi-Fi connection mode selector.
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Select Mode (USB or WIFI):
              </label>
              <select
                value={mode}
                id="connectionMode"
                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
              >
                <option className="bg-white" value="usb">
                  USB
                </option>
                <option className="" value="wifi">
                  WIFI
                </option>
              </select>
              */}
              {/* Wi-Fi address fields are temporarily disabled with Wi-Fi mode.
              <div className="gap-2 hidden" id="serverURL">
                <input
                  type="text"
                  id="phoneIP"
                  value={phoneIP}
                  onChange={(e) => setPhoneIP(e.target.value)}
                  placeholder="IP"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
                />
                <input
                  type="text"
                  value={streamProtocol === "mjpeg" ? httpPort : rtspPort}
                  id="port"
                  onChange={
                    streamProtocol === "mjpeg"
                      ? (e) => setHttpPort(e.target.value)
                      : (e) => setRtspPort(e.target.value)
                  }
                  placeholder="Port"
                  className="w-20 bg-slate-800/50 border border-slate-700 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
                />
              </div>
              */}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Select Stream Mode (MJPEG or RTSP):
                </label>
                <select
                  value={streamProtocol}
                  onChange={(e) => {
                    setStreamProtocol(e.target.value);
                  }}
                  id="streamProtocol"
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg p-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
                >
                  <option className="bg-white" value="mjpeg">
                    MJPEG
                  </option>
                  <option className="" value="rtsp">
                    RTSP
                  </option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={handleToggle}
                id="toggleConnectBtn"
                disabled={connectButtonDisable}
                className={`w-full ${connectButtonDisable ? "bg-slate-500 hover:bg-slate-600 cursor-not-allowed text-white" : isConnected ? "bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 cursor-pointer" : "bg-brand-500 hover:bg-brand-600 text-white cursor-pointer"} font-semibold py-2.5 rounded-lg transition-all active:scale-95 flex items-center justify-center gap-2`}
              >
                <span id="toggleConnectBtnText">{connectButtonText}</span>
              </button>
            </div>
          </div>

          {showControls && (
            <div className="space-y-4 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Camera Controls
                </label>
                <button
                  onClick={fetchSettings}
                  className="text-xs text-brand-400 hover:text-brand-300 transition-colors flex items-center gap-1 cursor-pointer"
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Sync
                </button>
              </div>
              <div className="flex">
                <button
                  onClick={handleSwitchCamera}
                  className="w-full border border-slate-700 hover:border-brand-500/50 hover:bg-brand-500/10 text-slate-300 py-2 rounded-lg text-sm transition-all flex items-center justify-center gap-2 m-1"
                >
                  {camera === "front" ? "Switch to Back" : "Switch to Front"}
                </button>

                <button
                  onClick={handleFlash}
                  className="w-full border border-slate-700 hover:border-brand-500/50 hover:bg-brand-500/10 text-slate-300 py-2 rounded-lg text-sm transition-all flex items-center justify-center gap-2 m-1"
                >
                  {isFlashOn ? "Turn off Flash" : "Turn on Flash"}
                </button>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-slate-500 font-bold uppercase">
                    Resolution
                  </span>
                  <span className="text-[9px] text-brand-400 font-mono">
                    {deviceSettings?.resolution_str || "Loading..."}
                  </span>
                </div>
                <select
                  value={deviceSettings?.resolution_str || ""}
                  onChange={(e) =>
                    sendControl(
                      `resolution_str=${encodeURIComponent(e.target.value)}`,
                      `Resolution: ${e.target.value}`,
                      "resolution",
                      `${e.target.value}`,
                    )
                  }
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {resolutions.map((res) => (
                    <option key={res} value={res}>
                      {res}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-slate-500 font-bold uppercase">
                    Focus Mode
                  </span>
                  <select
                    value={focusMode}
                    onChange={(e) => {
                      setFocusMode(e.target.value);
                      sendControl(
                        `focus_mode=${e.target.value}`,
                        `Focus Mode: ${e.target.value === "0" ? "AUTO" : "MANUAL"}`,
                        "focusMode",
                      );
                    }}
                    className="bg-transparent text-[10px] text-brand-400 font-bold outline-none cursor-pointer"
                  >
                    <option value="0" className="bg-slate-900">
                      AUTO
                    </option>
                    <option
                      value="1"
                      className="bg-slate-900"
                      disabled={!manualFocus}
                    >
                      MANUAL
                    </option>
                  </select>
                </div>
                <p
                  className={`text-[9px] ${manualFocus ? "text-emerald-400" : "text-red-400"}`}
                >
                  {manualFocus
                    ? "Manual focus supported"
                    : "Fixed focus camera"}
                </p>
                {focusMode === "1" && (
                  <div className="space-y-1">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[9px] text-slate-500">
                        Distance
                      </span>
                      <span className="text-[9px] text-brand-400 font-mono">
                        {manualFocusValue}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1000"
                      value={manualFocusValue}
                      onChange={handleFocusChange}
                      onMouseDown={() => {
                        isDraggingFocus.current = true;
                      }}
                      onMouseUp={() => {
                        isDraggingFocus.current = false;
                      }}
                      onTouchStart={() => {
                        isDraggingFocus.current = true;
                      }}
                      onTouchEnd={() => {
                        isDraggingFocus.current = false;
                      }}
                      className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
                    />
                    <div className="flex justify-between text-[8px] text-slate-500 uppercase">
                      <span>Infinity</span>
                      <span>Macro</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2 pt-2 border-t border-slate-800/50">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-slate-500 font-bold uppercase">
                    Exposure
                  </span>
                  <span className="text-[9px] text-brand-400 font-mono">
                    {exposure.value}
                  </span>
                </div>
                <input
                  type="range"
                  min={exposure.min}
                  max={exposure.max}
                  value={exposure.value}
                  disabled={exposure.disabled}
                  onChange={handleExposureChange}
                  onMouseDown={() => {
                    isDraggingExposure.current = true;
                  }}
                  onMouseUp={() => {
                    isDraggingExposure.current = false;
                  }}
                  onTouchStart={() => {
                    isDraggingExposure.current = true;
                  }}
                  onTouchEnd={() => {
                    isDraggingExposure.current = false;
                  }}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-brand-500 disabled:opacity-30 disabled:cursor-not-allowed"
                />
                <div className="flex justify-between text-[8px] text-slate-500 uppercase">
                  <span>Darker</span>
                  <span>Brighter</span>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3 pt-2 border-t border-slate-800">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Tools
            </label>
            <button
              id="startVirtualCamBtn"
              disabled={false}
              onClick={() => {
                handleVC();
              }}
              className={`w-full border  ${!vc && "hover:border-emerald-500/50"} ${vc ? "border-red-500" : "border-slate-700"} ${vc && "hover:bg-red-500/10"} ${!vc && "hover:bg-emerald-500/10"}   text-slate-300 py-2 rounded-lg text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-30`}
            >
              {!vc ? "Start Virtual Cam" : "Stop"}
            </button>
          </div>

          <div className="mt-auto p-4 bg-slate-900/80 rounded-xl border border-slate-800/50 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-500">Status</span>
              <span
                id="modeIndicator"
                className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 uppercase"
              >
                {status.state}
              </span>
            </div>
            <div
              id="status"
              className={`text-sm font-medium italic ${status.state === "error" ? "text-red-400" : ""} ${status.state === "active" ? "text-emerald-400" : ""} ${status.state === "idle" ? "text-brand-500" : ""}`}
            >
              {status.message}
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 relative flex flex-col bg-[#020617]">
          <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
            <div className="absolute -top-24 -right-24 w-96 h-96 bg-brand-600/10 rounded-full blur-[120px]"></div>
            <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-emerald-600/5 rounded-full blur-[120px]"></div>
          </div>

          <div className="flex-1 flex items-center justify-center p-8">
            <div
              id="placeholder"
              className={`${isConnected ? "hidden" : "block"} max-w-md text-center space-y-6`}
            >
              <div className="w-20 h-20 bg-slate-800/50 rounded-3xl mx-auto flex items-center justify-center border border-slate-700">
                <svg
                  className="w-10 h-10 text-slate-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
                  />
                </svg>
              </div>
              <div>
                <h2 className="text-2xl font-bold text-white mb-2">
                  Connect Your Stream
                </h2>
                <p className="text-slate-400 text-sm leading-relaxed">
                  Toggle your phone's webcam server and enter the URL in the
                  sidebar.
                </p>
              </div>
            </div>

            <div
              id="videoStreamDiv"
              className={`${isConnected ? "block" : "hidden"} relative w-full h-full flex items-center justify-center`}
            >
              <Preview isConnected={isConnected} channel={previewChannel.current} />
            </div>
          </div>

          <div
            id="toast"
            className={`absolute bottom-6 right-6 px-6 py-3 rounded-xl glass border-brand-500/30 text-sm font-medium opacity-0 transition-all duration-300 pointer-events-none ${toast.visible ? "translate-y-0 opacity-100" : "translate-y-20 opacity-0"} ${toast.isError ? "border-red-500/30" : "border-brand-500/30"}`}
          >
            {toast.message}
          </div>
        </main>
      </div>
    </>
  );
}
export default Home;
