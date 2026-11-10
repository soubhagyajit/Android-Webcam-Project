import "../App.css";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import Preview from "../components/preview";

function Home() {
  //app-version
  const [appVersion, setAppVersion] = useState("");

  // connection settings
  const [mode, setMode] = useState("usb");
  const [phoneIP, setPhoneIP] = useState("127.0.0.1");
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

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
  const [previewActive, setPreviewActive] = useState(false);
  const [feedActive, setFeedActive] = useState(false);

  // UI states
  const [connectButtonText, setConnectButtonText] = useState("Connect");
  const [connectButtonDisable, setConnectButtonDisable] = useState(false);

  //devices
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [wifiDevices, setWifiDevices] = useState([]);
  const [wifiDeviceState, setWifiDeviceState] = useState({});
  const [wifiScanError, setWifiScanError] = useState("");
  const [lastWifiDevice, setLastWifiDevice] = useState(null);
  const scanSequenceRef = useRef(0);
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
  const [streamData, setStreamData] = useState({ width: 1280, height: 720 });

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

  // A Tauri Channel is single-use: each start_sender call creates a fresh
  // channel on the Rust side (its message counter restarts at 0) and the JS
  // Channel only delivers messages in index order, then unregisters itself
  // when the Rust side drops. Reusing one JS Channel therefore worked for the
  // first sender session and silently dropped every frame after that. So we
  // make a new Channel per start_sender and forward its messages to whatever
  // handler <Preview> has registered in previewHandlerRef.
  const previewHandlerRef = useRef(null);
  const createPreviewChannel = () => {
    const channel = new Channel();
    channel.onmessage = (message) => previewHandlerRef.current?.(message);
    return channel;
  };
  const syncSettingsInterval = useRef(null);
  const syncFeaturesInterval = useRef(null);
  const debounceRef = useRef(null);
  const settingsStore = useRef(null);
  const firstModeEffect = useRef(true);
  const streamConfigRef = useRef(null);
  const feedActiveRef = useRef(false);
  const feedTransitionRef = useRef(false);
  const senderRetryAtRef = useRef(0);
  const senderRetryCountRef = useRef(0);
  const senderRetryBlockedRef = useRef(false);
  const senderStartedAtRef = useRef(0);
  const cameraUseCandidateRef = useRef(false);
  const cameraUseCandidateSinceRef = useRef(0);
  const cameraDemandRef = useRef(false);
  const lastCameraUseRef = useRef(null);
  const lastStableCameraUseRef = useRef(false);
  const lastFeedDemandRef = useRef(null);
  const skipInitialResolutionRestartRef = useRef(true);
  const previewTimerRef = useRef(null);

  const logDiagnostic = (event, details = {}) => {
    const message = JSON.stringify({ at: new Date().toISOString(), event, ...details });
    console.info("[AWC virtual camera]", message);
    invoke("write_diagnostic_log", { message }).catch((error) => {
      console.warn("Could not save virtual camera diagnostics:", error);
    });
  };

  // Tracking interaction state via refs to avoid stale closures in setInterval
  const isDraggingFocus = useRef(false);
  const isDraggingExposure = useRef(false);
  const isDraggingZoom = useRef(false);

  const toastDiv = document.getElementById("toast");

  useEffect(() => {
    getVersion().then((v) => {
      setAppVersion(v);
      getCurrentWindow().setTitle(`AWC v${v}`);
    });
  }, []);

  useEffect(() => {
    invoke("init_cam", { on: true, height: 720, width: 1280 }).catch((error) => {
      console.error("Failed to initialize virtual camera:", error);
      updateStatus("Virtual camera failed to start", "error");
    });
  }, []);

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const store = await load("settings.json", { autoSave: false });
        settingsStore.current = store;
        const savedMode = await store.get("connectionMode");
        const savedIP = await store.get("phoneIP");
        const lastWifiDevice = await store.get("lastWifiDevice");
        setLastWifiDevice(lastWifiDevice || null);
        const initialMode = savedMode === "wifi" ? "wifi" : "usb";

        setMode(initialMode);
        setPhoneIP(
          initialMode === "usb"
            ? "127.0.0.1"
            : typeof lastWifiDevice?.ip === "string" && lastWifiDevice.ip.trim()
              ? lastWifiDevice.ip
              : typeof savedIP === "string" && savedIP.trim()
                ? savedIP
                : "192.168.31.12",
        );
      } catch (error) {
        console.error("Could not load connection preferences:", error);
      } finally {
        setPreferencesLoaded(true);
      }
    };

    loadPreferences();
  }, []);

  useEffect(() => {
    if (!preferencesLoaded || !settingsStore.current) return;

    const savePreferences = async () => {
      await settingsStore.current.set("connectionMode", mode);
      await settingsStore.current.set("phoneIP", phoneIP);
      await settingsStore.current.save();
    };

    savePreferences().catch((error) =>
      console.error("Could not save connection preferences:", error),
    );
  }, [mode, phoneIP, preferencesLoaded]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const isInitialEffect = firstModeEffect.current;
    firstModeEffect.current = false;
    if (mode === "usb") {
      if (!isInitialEffect) setPhoneIP("127.0.0.1");
      setHttpPort("8080");
      handleGetDevices();
    } else if (mode === "wifi") {
      if (!isInitialEffect) setPhoneIP(lastWifiDevice?.ip || "192.168.31.12");
      setHttpPort("8080");
    }
  }, [mode, preferencesLoaded]);

  useEffect(() => {
    if (!preferencesLoaded || mode !== "wifi") {
      scanSequenceRef.current += 1;
      invoke("cancel_device_scan").catch(() => {});
      setWifiScanning(false);
      return;
    }

    let disposed = false;
    let unlisten = [];
    const addWifiDevice = (device) => {
      if (!device?.ip) return;
      setWifiDevices((current) => current.some((item) => item.ip === device.ip)
        ? current
        : [...current, device]);
    };

    const setupScan = async () => {
      const stopDeviceListener = await listen("scan-device-found", (event) => {
        if (event.payload?.requestId === scanSequenceRef.current) {
          addWifiDevice(event.payload.device);
        }
      });
      if (disposed) stopDeviceListener();
      else unlisten.push(stopDeviceListener);

      const stopFinishedListener = await listen("scan-finished", (event) => {
        if (!disposed && event.payload?.requestId === scanSequenceRef.current) {
          setWifiScanning(false);
          if (event.payload?.error) setWifiScanError(event.payload.error);
          else setWifiScanError("");
        }
      });
      if (disposed) stopFinishedListener();
      else unlisten.push(stopFinishedListener);
      if (!disposed) runWifiScan();
    };
    setupScan().catch((error) => {
      console.error("Could not listen for discovery events:", error);
      setWifiScanError("Device discovery could not start.");
      setWifiScanning(false);
    });

    return () => {
      disposed = true;
      scanSequenceRef.current += 1;
      invoke("cancel_device_scan").catch(() => {});
      unlisten.forEach((stop) => stop());
    };
  }, [mode, preferencesLoaded]);

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
      if (skipInitialResolutionRestartRef.current) {
        skipInitialResolutionRestartRef.current = false;
        return;
      }
      await invoke("init_cam", { on: false, height: streamData.height, width: streamData.width });
      await invoke("init_cam", { on: true, height: streamData.height, width: streamData.width });
    };
    applyResolutionChange();
  }, [streamData.width, streamData.height]);

  // Pull from the phone only while Softcam has a consumer or the user has
  // explicitly enabled the short preview window.
  useEffect(() => {
    let disposed = false;
    const syncFeedDemand = async () => {
      if (disposed || feedTransitionRef.current) return;
      const config = streamConfigRef.current;
      let cameraConnectedRaw = false;
      if (isConnected && vc) {
        try { cameraConnectedRaw = await invoke("cam_client_connected"); } catch (_) {}
      }
      const now = Date.now();
      const cameraDetectionEnabled = isConnected && vc;
      if (!cameraDetectionEnabled) {
        cameraUseCandidateRef.current = false;
        cameraUseCandidateSinceRef.current = now;
        cameraDemandRef.current = false;
      } else if (cameraConnectedRaw !== cameraUseCandidateRef.current) {
        cameraUseCandidateRef.current = cameraConnectedRaw;
        cameraUseCandidateSinceRef.current = now;
      }

      const cameraStateStableFor = now - cameraUseCandidateSinceRef.current;
      if (cameraDetectionEnabled && cameraUseCandidateRef.current) {
        if (!cameraDemandRef.current && cameraStateStableFor >= 2000) {
          cameraDemandRef.current = true;
        }
      } else if (cameraDetectionEnabled) {
        cameraDemandRef.current = false;
      }

      if (lastCameraUseRef.current !== cameraConnectedRaw) {
        lastCameraUseRef.current = cameraConnectedRaw;
        logDiagnostic("softcam-consumer-state", {
          connectedToPhone: isConnected,
          virtualCameraEnabled: vc,
          rawConnected: cameraConnectedRaw,
          stableConsumerConnected: cameraDemandRef.current,
          stableForMs: cameraStateStableFor,
        });
      }
      const cameraInUse = cameraDemandRef.current;
      if (lastStableCameraUseRef.current !== cameraInUse) {
        lastStableCameraUseRef.current = cameraInUse;
        logDiagnostic("softcam-stable-consumer-state", {
          virtualCameraEnabled: vc,
          consumerConnected: cameraInUse,
          rawConnected: cameraConnectedRaw,
          stableForMs: cameraStateStableFor,
        });
      }
      const wanted = !!config && isConnected && (previewActive || cameraInUse);
      if (lastFeedDemandRef.current !== wanted) {
        lastFeedDemandRef.current = wanted;
        logDiagnostic("phone-feed-demand", {
          wanted,
          previewActive,
          virtualCameraEnabled: vc,
          consumerConnected: cameraInUse,
          rawConsumerConnected: cameraConnectedRaw,
          consumerStateStableForMs: cameraStateStableFor,
          senderBelievedRunning: feedActiveRef.current,
        });
      }
      const nativeFeedRunning = await invoke("sender_is_running").catch(() => false);
      if (feedActiveRef.current && !nativeFeedRunning) {
        feedActiveRef.current = false;
        setFeedActive(false);
        const now = Date.now();
        const hadStableRun = now - senderStartedAtRef.current >= 10_000;
        senderRetryCountRef.current = hadStableRun ? 1 : senderRetryCountRef.current + 1;
        senderStartedAtRef.current = 0;
        const endReason = await invoke("sender_last_end_reason").catch(() => "unknown");
        logDiagnostic("sender-ended", {
          wanted,
          retryCount: senderRetryCountRef.current,
          hadStableRun,
          endReason,
        });

        if (wanted && senderRetryCountRef.current >= 3) {
          senderRetryBlockedRef.current = true;
          updateStatus("Phone feed stopped after repeated disconnects. Reconnect the phone to retry.", "error");
        } else if (wanted) {
          const retryDelay = senderRetryCountRef.current === 1 ? 1200 : 4000;
          senderRetryAtRef.current = now + retryDelay;
          updateStatus("Phone feed interrupted; retrying…", "error");
        }
      } else if (!feedActiveRef.current && nativeFeedRunning) {
        feedActiveRef.current = true;
        setFeedActive(true);
      }
      if (wanted && senderRetryBlockedRef.current) return;
      if (!feedActiveRef.current && wanted && Date.now() < senderRetryAtRef.current) return;
      if (wanted === feedActiveRef.current) return;
      const senderStopping = await invoke("sender_is_stopping").catch(() => false);
      if (wanted && senderStopping) {
        logDiagnostic("sender-start-deferred", { reason: "previous sender is still stopping" });
        return;
      }
      feedTransitionRef.current = true;
      try {
        if (wanted) {
          logDiagnostic("sender-start-request", {
            source: config.source,
            previewActive,
            virtualCameraEnabled: vc,
            consumerConnected: cameraInUse,
          });
          const started = await invoke("start_sender", {
            source: config.source,
            url: config.url,
            onFrame: createPreviewChannel(),
          });
          logDiagnostic("sender-start-result", { started });
          if (!started) {
            senderRetryAtRef.current = Date.now() + 1200;
            return;
          }
          feedActiveRef.current = true;
          setFeedActive(true);
          senderStartedAtRef.current = Date.now();
          updateStatus(previewActive ? "Connecting to phone preview…" : "Connecting phone feed to virtual camera…", "idle");
        } else {
          logDiagnostic("sender-stop-request", {
            previewActive,
            virtualCameraEnabled: vc,
            consumerConnected: cameraInUse,
          });
          await invoke("stop_sender");
          feedActiveRef.current = false;
          setFeedActive(false);
          if (isConnected) updateStatus("Connected · waiting for camera use", "idle");
        }
      } finally {
        feedTransitionRef.current = false;
      }
    };
    syncFeedDemand();
    const timer = setInterval(syncFeedDemand, 400);
    return () => { disposed = true; clearInterval(timer); };
  }, [isConnected, vc, previewActive]);

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
    logDiagnostic("virtual-camera-toggle", { enabled: !i });
    senderRetryCountRef.current = 0;
    senderRetryBlockedRef.current = false;
    senderRetryAtRef.current = 0;
    setVc(!i);
    await invoke("set_cam_active", { active: !i });
    updateStatus(i ? "Virtual camera stopped" : "Virtual camera started", i ? "idle" : "active");
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

  const runWifiScan = async () => {
    if (mode !== "wifi") return;
    const requestId = ++scanSequenceRef.current;
    setWifiScanning(true);
    setWifiScanError("");
    setWifiDevices([]);
    setWifiDeviceState({});
    if (lastWifiDevice?.ip) {
      fetchUrl(`http://${lastWifiDevice.ip}:${lastWifiDevice.port || 8080}/features`, { timeoutMs: 700 })
        .then(async (response) => {
          if (!response.ok) return null;
          const features = await response.json();
          if (!Array.isArray(features.resolutions) || !features.stream_protocol) return null;
          return {
            ...lastWifiDevice,
            port: features.server_port || lastWifiDevice.port || 8080,
            protocol: features.stream_protocol,
          };
        })
        .then((device) => {
          if (device && requestId === scanSequenceRef.current) {
            setWifiDeviceState((current) => ({ ...current, [device.ip]: "ready" }));
            setWifiDevices((current) => current.some((item) => item.ip === device.ip)
              ? current
              : [device, ...current]);
          }
        })
        .catch(() => {});
    }
    try {
      await invoke("cancel_device_scan");
      const found = await invoke("discover_devices", { requestId });
      if (requestId === scanSequenceRef.current) {
        setWifiDevices((current) => {
          const byIp = new Map(current.map((device) => [device.ip, device]));
          (found || []).forEach((device) => byIp.set(device.ip, device));
          const values = [...byIp.values()];
          return lastWifiDevice
            ? values.sort((a, b) => Number(b.ip === lastWifiDevice.ip) - Number(a.ip === lastWifiDevice.ip))
            : values;
        });
        setWifiScanning(false);
      }
    } catch (error) {
      if (requestId === scanSequenceRef.current) {
        console.warn("WiFi discovery failed:", error);
        setWifiScanError(String(error));
        setWifiScanning(false);
      }
    }
  };

  const handleWifiDeviceSelect = async (device) => {
    setPhoneIP(device.ip);
    setHttpPort(String(device.port || 8080));
    setWifiDeviceState((current) => ({ ...current, [device.ip]: "checking" }));
    try {
      const response = await fetchUrl(`http://${device.ip}:${device.port || 8080}/features`, { timeoutMs: 1500 });
      if (!response.ok) throw new Error(`Phone returned HTTP ${response.status}`);
      const features = await response.json();
      if (!Array.isArray(features.resolutions) || !features.stream_protocol) {
        throw new Error("The device did not return valid AWA features.");
      }
      const isRtsp = String(features.stream_protocol).toUpperCase() === "H264_RTSP";
      setStreamProtocol(isRtsp ? "rtsp" : "mjpeg");
      if (features.server_port) setHttpPort(String(features.server_port));
      if (isRtsp && features.rtsp_port) setRtspPort(String(features.rtsp_port));
      setDeviceFeatures(features);
      setResolutions(features.resolutions);
      setWifiScanError("");
      setWifiDeviceState((current) => ({ ...current, [device.ip]: "ready" }));
      const selected = {
        name: device.name,
        ip: device.ip,
        port: features.server_port || device.port || 8080,
        protocol: features.stream_protocol,
      };
      setLastWifiDevice(selected);
      try {
        await settingsStore.current?.set("lastWifiDevice", selected);
        await settingsStore.current?.save();
      } catch (error) {
        console.warn("Could not persist the last AWA device:", error);
      }
    } catch (error) {
      setWifiDeviceState((current) => ({ ...current, [device.ip]: "error" }));
      showToast(`Could not confirm ${device.ip}: ${error.message || error}`, true);
    }
  };

  const handleConnect = async () => {
    setConnectButtonDisable(true);
    setConnectButtonText("Connecting...");
    updateStatus("Querying device features...", "idle");

    try {
      await waitForSenderShutdown();
      const response = await fetchUrl(`http://${phoneIP}:${httpPort}/features`);
      const features = await response.json();

      setStreamProtocol("mjpeg");
      let targetUrl = `http://${phoneIP}:${httpPort}/video`;
      const isRtsp = String(features.stream_protocol || "").toUpperCase().includes("RTSP");

      if (isRtsp) {
        const selectedRtspPort = features.rtsp_port || Number(rtspPort) || 8554;
        setStreamProtocol("rtsp");
        setRtspPort(String(selectedRtspPort));
        targetUrl = `rtsp://${phoneIP}:${selectedRtspPort}/awa`;
      }

      streamConfigRef.current = { source: isRtsp ? "rtsp" : "mjpeg", url: targetUrl };
      if (mode === "wifi") {
        const usedDevice = {
          name: wifiDevices.find((device) => device.ip === phoneIP)?.name || `AWA device (${phoneIP})`,
          ip: phoneIP,
          port: features.server_port || Number(httpPort) || 8080,
          protocol: features.stream_protocol || (isRtsp ? "H264_RTSP" : "MJPEG"),
        };
        setLastWifiDevice(usedDevice);
        try {
          await settingsStore.current?.set("lastWifiDevice", usedDevice);
          await settingsStore.current?.save();
        } catch (error) {
          console.warn("Could not persist the last AWA device:", error);
        }
      }
      logDiagnostic("phone-connect-succeeded", { source: isRtsp ? "rtsp" : "mjpeg" });

      setIsConnected(true);
      setShowControls(true);
      setConnectButtonDisable(false);
      setConnectButtonText("Disconnect");
      setModeIndicator("streaming");
      updateStatus("Connected · waiting for camera use", "idle");
      startPreviewWindow();

      if (features.resolutions) {
        setResolutions(features.resolutions);
      }

      // 4. Start background settings/features sync interval
      await initializeDeviceSync();
    } catch (err) {
      console.error("Failed to fetch features or connect:", err);
      if (mode === "wifi") {
        setWifiDeviceState((current) => ({ ...current, [phoneIP]: "error" }));
      }
      await handleDisconnect();
      updateStatus("Connection failed. Check the phone and network, then rescan or try the IP again.", "error");
    }
  };

  const handleDisconnect = async () => {
    logDiagnostic("phone-disconnect-requested", {
      virtualCameraEnabled: vc,
      senderBelievedRunning: feedActiveRef.current,
    });
    setIsConnected(false);
    setConnectButtonDisable(true);
    setConnectButtonText("Connect");
    setShowControls(false);

    streamConfigRef.current = null;
    setPreviewActive(false);
    invoke("set_preview_enabled", { enabled: false }).catch(() => {});
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
    feedActiveRef.current = false;
    senderRetryAtRef.current = 0;
    senderRetryCountRef.current = 0;
    senderRetryBlockedRef.current = false;
    senderStartedAtRef.current = 0;
    setFeedActive(false);

    // These don't depend on the sender, so do them first: if shutdown below
    // is slow or fails, we must not leave them polling a disconnected phone.
    if (syncSettingsInterval.current || syncFeaturesInterval.current) {
      clearInterval(syncSettingsInterval.current);
      clearInterval(syncFeaturesInterval.current);
      syncSettingsInterval.current = null;
      syncFeaturesInterval.current = null;
    }

    try {
      await invoke("stop_sender");
      await waitForSenderShutdown();
      updateStatus("Disconnected", "idle");
    } catch (error) {
      // waitForSenderShutdown throws if the old feed won't stop. Still show
      // the app as disconnected and re-enable the button; Connect waits for
      // the sender again before starting a new session.
      console.error("Phone feed did not shut down cleanly:", error);
      logDiagnostic("sender-shutdown-failed", { error: String(error) });
      updateStatus("Disconnected (previous feed still closing)", "idle");
    } finally {
      setConnectButtonDisable(false);
    }
  };

  const waitForSenderShutdown = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const [running, stopping] = await Promise.all([
        invoke("sender_is_running").catch(() => false),
        invoke("sender_is_stopping").catch(() => false),
      ]);
      if (!running && !stopping) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Previous phone feed is still stopping");
  };

  const handlePreviewToggle = () => {
    if (!isConnected) return;
    startPreviewWindow();
  };

  const startPreviewWindow = () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    senderRetryCountRef.current = 0;
    senderRetryBlockedRef.current = false;
    senderRetryAtRef.current = 0;
    invoke("set_preview_enabled", { enabled: true }).catch((error) => {
      console.error("Failed to enable preview channel:", error);
    });
    setPreviewActive(true);
    previewTimerRef.current = setTimeout(() => {
      invoke("set_preview_enabled", { enabled: false }).catch((error) => {
        console.error("Failed to pause preview channel:", error);
      });
      setPreviewActive(false);
      previewTimerRef.current = null;
    }, 30_000);
  };
  const initializeDeviceSync = async () => {
    await fetchFeatures();
    await fetchSettings();
    if (syncInterval !== 0 && !syncSettingsInterval.current) {
      syncSettingsInterval.current = setInterval(() => {
        // Pause fetching settings while the user is actively using the sliders
        if (
          !isDraggingFocus.current &&
          !isDraggingExposure.current &&
          !isDraggingZoom.current
        ) {
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

  const handleZoomChange = (e) => {
    const val = Number(e.target.value);
    setDeviceSettings((prev) => ({ ...prev, zoom: val }));
    sendControlDebounced(`zoom=${val}`, `Zoom: ${val.toFixed(1)}x`);
  };

  const openAndroidAppPage = (event) => {
    event.preventDefault();
    openUrl("https://play.google.com/store/apps/details?id=com.soubhagyajit.awa").catch(
      (error) => console.error("Could not open Google Play page:", error),
    );
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
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Select Mode (USB or WIFI):
              </label>
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                }}
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
              {mode === "wifi" && (
                <div className="space-y-3" id="serverURL">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      Devices on your network
                    </label>
                    <button
                      type="button"
                      onClick={runWifiScan}
                      aria-label={wifiScanning ? "Rescan AWA devices while the scan is running" : "Rescan AWA devices"}
                      aria-busy={wifiScanning}
                      className="text-xs text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
                    >
                      <svg
                        aria-hidden="true"
                        className={`mr-1 inline-block h-3 w-3 ${wifiScanning ? "animate-spin" : ""}`}
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
                      Rescan
                    </button>
                  </div>
                  {wifiDevices.length > 0 && (
                    <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-700/70 bg-slate-950/50 p-1">
                      {wifiDevices.map((device) => {
                        const state = wifiDeviceState[device.ip] || "new";
                        const unavailable = state === "error";
                        const checking = state === "checking";
                        return (
                          <button
                            type="button"
                            key={device.ip}
                            onClick={() => handleWifiDeviceSelect(device)}
                            disabled={unavailable || checking}
                            aria-label={`${device.name || "AWA device"}, ${device.ip}, ${String(device.protocol || "MJPEG").toUpperCase()}${unavailable ? ", unavailable" : checking ? ", checking connection" : state === "ready" ? ", connection confirmed" : ""}`}
                            className={`flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-left transition-colors ${unavailable ? "border-red-500/40 bg-red-500/5 text-red-200 cursor-not-allowed" : state === "ready" ? "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 cursor-pointer" : "border-transparent hover:bg-slate-800 cursor-pointer"} ${phoneIP === device.ip && !unavailable ? "ring-1 ring-emerald-500/40" : ""} ${checking ? "cursor-not-allowed opacity-70" : ""}`}
                          >
                            <span className="min-w-0 text-left">
                              <span className="block truncate text-xs font-medium">{device.name || "AWA device"}</span>
                              <span className={`block text-[11px] ${unavailable ? "text-red-300" : state === "ready" ? "text-emerald-300" : "text-slate-500"}`}>
                                {device.ip}:{device.port}
                                {checking ? " · Checking…" : unavailable ? " · Connection failed" : state === "ready" ? " · Ready" : ""}
                              </span>
                            </span>
                            <span className={`ml-2 shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${unavailable ? "bg-red-500/15 text-red-300" : state === "ready" ? "bg-emerald-500/15 text-emerald-300" : "bg-brand-500/15 text-brand-300"}`}>
                              {String(device.protocol || "MJPEG").toUpperCase()}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {wifiScanning && (
                    <p className="text-xs text-slate-400">Scanning local network…</p>
                  )}
                  {!wifiScanning && wifiDevices.length === 0 && (
                    <p
                      role={wifiScanError ? "alert" : "status"}
                      aria-live={wifiScanError ? "assertive" : "polite"}
                      className={`rounded-lg border p-2.5 text-xs leading-relaxed ${wifiScanError ? "border-red-500/40 bg-red-500/5 text-red-200" : "border-slate-800 bg-slate-900/50 text-slate-400"}`}
                    >
                      No devices found. mDNS may be blocked by Windows Firewall or your Wi-Fi router; allow local network discovery or connect both devices to the same non-guest network. You can still enter the phone’s IP below.
                      {wifiScanError ? <span className="mt-1 block font-medium text-red-300">{wifiScanError}</span> : null}
                    </p>
                  )}
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor="phoneIP" className="mb-1 block text-[11px] font-medium text-slate-400">Manual IP address</label>
                      <input
                        type="text"
                        id="phoneIP"
                        value={phoneIP}
                        onChange={(e) => setPhoneIP(e.target.value)}
                        placeholder="e.g. 192.168.43.1"
                        autoComplete="off"
                        className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
                      />
                    </div>
                    <div className="w-24 shrink-0">
                      <label htmlFor="port" className="mb-1 block text-[11px] text-slate-400">
                        {streamProtocol === "rtsp" ? "RTSP port" : "HTTP port"}
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={streamProtocol === "mjpeg" ? httpPort : rtspPort}
                        id="port"
                        onChange={streamProtocol === "mjpeg"
                          ? (e) => setHttpPort(e.target.value)
                          : (e) => setRtspPort(e.target.value)}
                        className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 outline-none transition-all"
                      />
                    </div>
                  </div>
                </div>
              )}
              {/* Temporarily disabled Stream Mode selector; protocol detection remains active in handleConnect.
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
              */}
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
            <fieldset
              disabled={status.state === "error"}
              aria-describedby="status"
              className="min-w-0 space-y-4 border-0 p-0 pt-2 disabled:opacity-50"
            >
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
                    Zoom
                  </span>
                  <span className="text-[9px] text-brand-400 font-mono">
                    {Number(deviceSettings.zoom ?? 1).toFixed(1)}x
                  </span>
                </div>
                <input
                  type="range"
                  min={deviceFeatures?.zoom_min ?? 1}
                  max={deviceFeatures?.zoom_max ?? 1}
                  step="0.1"
                  value={deviceSettings.zoom ?? 1}
                  disabled={
                    !Number.isFinite(deviceFeatures?.zoom_min) ||
                    !Number.isFinite(deviceFeatures?.zoom_max) ||
                    deviceFeatures.zoom_min >= deviceFeatures.zoom_max
                  }
                  onChange={handleZoomChange}
                  onMouseDown={() => {
                    isDraggingZoom.current = true;
                  }}
                  onMouseUp={() => {
                    isDraggingZoom.current = false;
                  }}
                  onTouchStart={() => {
                    isDraggingZoom.current = true;
                  }}
                  onTouchEnd={() => {
                    isDraggingZoom.current = false;
                  }}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-brand-500 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Zoom"
                />
                <div className="flex justify-between text-[8px] text-slate-500 uppercase">
                  <span>{deviceFeatures?.zoom_min ?? "—"}x</span>
                  <span>{deviceFeatures?.zoom_max ?? "—"}x</span>
                </div>
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
            </fieldset>
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
                role="status"
                aria-label={`Connection state: ${status.state}`}
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${status.state === "error" ? "bg-red-500/15 text-red-300" : status.state === "active" || isConnected ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700 text-slate-300"}`}
              >
                {status.state}
              </span>
            </div>
            <div
              id="status"
              role={status.state === "error" ? "alert" : "status"}
              aria-live={status.state === "error" ? "assertive" : "polite"}
              className={`text-sm font-medium italic ${status.state === "error" ? "text-red-400" : ""} ${status.state === "active" || isConnected ? "text-emerald-400" : ""} ${status.state === "idle" && !isConnected ? "text-brand-500" : ""}`}
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
              className={`${isConnected || vc || previewActive ? "hidden" : "grid"} w-full max-w-2xl grid-cols-1 sm:grid-cols-[1fr_auto] items-center gap-8`}
            >
              <section>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">
                  Get started
                </p>
                <h2 className="mt-2 text-2xl font-bold text-white">
                  Quick setup guide
                </h2>
                <ol className="mt-6 space-y-5">
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-bold text-brand-400">1</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-200">Install AWA on your phone</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">Scan the QR code or open the Google Play link.</p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-bold text-brand-400">2</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-200">Open AWA</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">Allow the requested permissions when prompted.</p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-bold text-brand-400">3</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-200">Choose USB or Wi-Fi in this client</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">For Wi-Fi, enter the phone’s IP address shown in AWA. For USB, connect the phone by cable.</p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-xs font-bold text-brand-400">4</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-200">Connect</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">Select your USB device if prompted, then click Connect in the sidebar.</p>
                    </div>
                  </li>
                </ol>
              </section>

              <a
                href="https://play.google.com/store/apps/details?id=com.soubhagyajit.awa"
                onClick={openAndroidAppPage}
                className="mx-auto flex w-36 flex-col items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 p-4 text-center transition-colors hover:border-brand-500/60 sm:mx-0"
                aria-label="Open AWA on Google Play"
              >
                <img
                  src="/awa-play-store-qr.png"
                  alt="QR code to install AWA from Google Play"
                  className="h-28 w-28 rounded-lg bg-white p-1"
                />
                <span className="text-xs font-semibold text-brand-400">Scan to install AWA</span>
              </a>
            </div>

            <div
              id="videoStreamDiv"
              className={`${isConnected || vc ? "flex" : "hidden"} relative w-full h-full items-center justify-center`}
            >
              <Preview
                phoneConnected={isConnected}
                feedActive={feedActive}
                cameraEnabled={vc || previewActive}
                cameraActive={vc}
                showPreview={previewActive}
                previewExpired={isConnected && !previewActive}
                onFrameReceived={() => setStatus({ message: "Phone feed preview", state: "active" })}
                width={streamData.width}
                height={streamData.height}
                frameHandlerRef={previewHandlerRef}
              />
            </div>
            {isConnected && (
              <button
                onClick={handlePreviewToggle}
                className="absolute top-5 right-5 z-10 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-xs text-slate-200 hover:border-brand-500/60"
              >
                {previewActive ? "Preview on · 30s" : "Show Preview · 30s"}
              </button>
            )}
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
