package com.soubhagyajit.awa.viewModel

import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.MotionEvent
import android.view.View
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.AspectRatio
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pedro.common.ConnectChecker
import com.pedro.library.view.OpenGlView
import com.pedro.rtspserver.RtspServerCamera2
import com.soubhagyajit.awa.server.VideoStreamServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class CameraViewModel : ViewModel() {

    enum class StreamMode(val label: String) {
        MJPEG("MJPEG"),
        H264_RTSP("H.264 (RTSP)")
    }

    enum class StreamResolution(val label: String, val size: Size, val aspectRatio: Int) {
        P480("480p", Size(640, 480), AspectRatio.RATIO_4_3),
        P720("720p", Size(1280, 720), AspectRatio.RATIO_16_9),
        P1080("1080p", Size(1920, 1080), AspectRatio.RATIO_16_9),
        P4K("4K", Size(3840, 2160), AspectRatio.RATIO_16_9)
    }

    enum class FocusMode { AUTO, MANUAL }

    data class CameraSettings(
        val resolution: StreamResolution = StreamResolution.P720,
        val lensFacing: Int = CameraSelector.LENS_FACING_BACK,
        val focusMode: FocusMode = FocusMode.AUTO,
        val focusDistance: Float = 0f, // 0.0 = infinity, 1.0 = closest
        val exposureIndex: Int = 0,
        val exposureRange: IntRange = 0..0,
        val jpegQuality: Int = 80,
        val hasFlashUnit: Boolean = false,
        val isFlashEnabled: Boolean = false,
        val zoom: Float = 1.0f,
        val zoomMin: Float = 1.0f,
        val zoomMax: Float = 1.0f,
    )

    @Volatile
    var currentFrame: ByteArray? = null
        private set

    private var mjpegCamera: androidx.camera.core.Camera? = null
    private var rtspCamera: RtspServerCamera2? = null
    private var appContext: Context? = null
    private var lifecycleOwner: LifecycleOwner? = null
    private var previewView: PreviewView? = null

    private val _isPreviewActive = mutableStateOf(false)
    val isPreviewActive: State<Boolean> = _isPreviewActive

    private val _isServerRunning = mutableStateOf(true)
    val isServerRunning: State<Boolean> = _isServerRunning

    private val _showLocalPreview = mutableStateOf(false)
    val showLocalPreview: State<Boolean> = _showLocalPreview
    private var hidePreviewRunnable: Runnable? = null
    private val previewPeekDurationMs = 50000L

    private val _streamMode = mutableStateOf(StreamMode.MJPEG)
    val streamMode: State<StreamMode> = _streamMode

    private val _settings = mutableStateOf(CameraSettings())
    val settings: State<CameraSettings> = _settings

    private val viewerCount = AtomicInteger(0)
    private val jpegViewerCount = AtomicInteger(0)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var cameraProvider: ProcessCameraProvider? = null
    private var cameraExecutor: ExecutorService? = null

    private var openGlView: OpenGlView? = null
    private val rtspPort = 8554
    private val rtspUrl = "rtsp://192.168.31.30:8554/awa"
    private val rtspBitrate = 16_000_000 // 16 Mbps default

    fun initialize(context: Context) {
        appContext = context.applicationContext

        // 1. Viewer Connection Callbacks
        VideoStreamServer.onUserConnected = {
            jpegViewerCount.incrementAndGet()
            if (viewerCount.incrementAndGet() == 1 && _isServerRunning.value && _streamMode.value == StreamMode.MJPEG) {
                viewModelScope.launch(Dispatchers.Main) {
                    _isPreviewActive.value = true
                    bindCamera()
                }
            }
        }

        VideoStreamServer.onUserDisconnected = {
            jpegViewerCount.updateAndGet { (it - 1).coerceAtLeast(0) }
            if (viewerCount.updateAndGet { (it - 1).coerceAtLeast(0) } == 0) {
                viewModelScope.launch(Dispatchers.Main) {
                    _isPreviewActive.value = false
                    unbindCamera()
                }
            }
        }

        // 2. Features Provider
        VideoStreamServer.featuresProvider = {
            val s = _settings.value
            val currentMode = _streamMode.value
            val maxZoom = getMaxZoom()
            val minZoom = getMinZoom()
            VideoStreamServer.FeaturesResponse(
                resolutions = StreamResolution.entries.map { "${it.size.width}x${it.size.height}" },
                manual_focus = true,
                exposure_lower = s.exposureRange.first,
                exposure_upper = s.exposureRange.last,
                stream_protocol = currentMode,
                server_port = 8080, // TODO - Give users option to modify it
                zoom_max = maxZoom,
                zoom_min = minZoom,
                has_zoom = maxZoom > minZoom,
                rtsp_port = if (currentMode == StreamMode.H264_RTSP) rtspPort else null
            )
        }

        // 3. Settings Provider
        VideoStreamServer.settingsProvider = {
            val s = _settings.value
            VideoStreamServer.SettingsResponse(
                camera = if (s.lensFacing == CameraSelector.LENS_FACING_BACK) "back" else "front",
                resolution_str = "${s.resolution.size.width}x${s.resolution.size.height}",
                zoom = s.zoom,
                flash = s.isFlashEnabled,
                exposure_index = s.exposureIndex,
                focus_mode = if (s.focusMode == FocusMode.AUTO) 0 else 1,
                focus_distance = s.focusDistance*1000,
                stream_quality = s.jpegQuality,
                has_flash_unit = s.hasFlashUnit,
            )
        }

        // 4. Remote Control Settings Callback
        VideoStreamServer.onSettingsUpdated = { update ->
            val isRtspActive = _streamMode.value == StreamMode.H264_RTSP && rtspCamera != null

            if (update.resolution_str != null && isRtspActive) {
                "Cannot change resolution while RTSP stream is active. Stop the stream first."
            } else {
                viewModelScope.launch(Dispatchers.Main) {
                    update.switchCamera?.let { if (it) switchCamera() }

                    update.autofocus?.let { enable ->
                        if (enable) {
                            _settings.value = _settings.value.copy(focusMode = FocusMode.AUTO)
                            cancelFocusAndMetering()
                        }
                    }
                    update.focus_distance?.let { dist ->
                        _settings.value = _settings.value.copy(focusMode = FocusMode.MANUAL)
                        val normalized = (dist.coerceIn(1f, 1000f) - 1f) / 999f
                        setFocusDistance(normalized)
                    }
                    update.focus_mode?.let {mode ->
                        Log.d("AWA","$mode")
                        if (mode == 1 ){
                            _settings.value = _settings.value.copy(focusMode = FocusMode.MANUAL)
                        }
                        else if (mode == 0){
                            _settings.value = _settings.value.copy(focusMode = FocusMode.AUTO)
                            cancelFocusAndMetering()
                        }
                    }
                    update.exposure_index?.let { setExposure(it) }

                    update.flash?.let { enable ->
                        if (_streamMode.value == StreamMode.MJPEG && mjpegCamera?.cameraInfo?.hasFlashUnit() == false) {
                            return@let
                        }
                        _settings.value = _settings.value.copy(isFlashEnabled = enable)
                        applyFlash(enable)
                    }

                    update.zoom?.let { setZoom(it) }

                    update.resolution_str?.let { resStr ->
                        StreamResolution.entries.find { "${it.size.width}x${it.size.height}" == resStr }
                            ?.let { setResolution(it) }
                    }
                    update.camera.let { state ->
                        val requestedFacing = if (state == "back") CameraSelector.LENS_FACING_BACK else CameraSelector.LENS_FACING_FRONT
                        if (_settings.value.lensFacing != requestedFacing) {
                            setCameraFacing(back = state == "back")
                        }
                    }
                    update.stream_quality?.let{value ->
                        _settings.value = _settings.value.copy(jpegQuality = value)
                    }
                }
                null
            }
        }

        VideoStreamServer.start(8080)
    }

    // --- Unified start/stop ---
    fun toggleServer() {
        if (_isServerRunning.value) {
            stopActiveStream()
            _isServerRunning.value = false
        } else {
            startActiveStream()
            _isServerRunning.value = true
        }
    }

    fun setStreamMode(mode: StreamMode) {
        if (_streamMode.value == mode) return
        val wasRunning = _isServerRunning.value
        val switchingFromMjpeg = _streamMode.value == StreamMode.MJPEG

        if (wasRunning) stopActiveStream()
        _streamMode.value = mode

        if (!wasRunning) return

        if (switchingFromMjpeg && mode == StreamMode.H264_RTSP) {
            // Camera2 device release from CameraX is async — give it
            // a moment before Camera2 (RootEncoder) tries to open it.
            mainHandler.postDelayed({ startActiveStream() }, 300L)
        } else {
            startActiveStream()
        }
    }

    private fun startActiveStream() {
        when (_streamMode.value) {
            StreamMode.MJPEG -> { }
            StreamMode.H264_RTSP -> startRtspCamera()
        }
    }

    private fun stopActiveStream() {
        when (_streamMode.value) {
            StreamMode.MJPEG -> {
                unbindCamera()
                _isPreviewActive.value = false
            }
            StreamMode.H264_RTSP -> stopRtspCamera()
        }
        hideLocalPreview()
    }

    // --- Touch-driven local preview ---

    fun notifyScreenTapped() {
        if (!_isServerRunning.value) return
        _showLocalPreview.value = true
        if (_streamMode.value == StreamMode.MJPEG) {
            startPreviewHideTimer()
        }
    }

    private fun startPreviewHideTimer() {
        hidePreviewRunnable?.let { mainHandler.removeCallbacks(it) }
        val runnable = Runnable { hideLocalPreview() }
        hidePreviewRunnable = runnable
        mainHandler.postDelayed(runnable, previewPeekDurationMs)
    }

    private fun hideLocalPreview() {
        hidePreviewRunnable?.let { mainHandler.removeCallbacks(it) }
        hidePreviewRunnable = null
        _showLocalPreview.value = false
    }

    private fun buildConnectChecker() = object : ConnectChecker {
        override fun onConnectionStarted(url: String) {
            Log.d("AWA", "RTSP: connection started, url=$url")
        }
        override fun onConnectionSuccess() {
            Log.d("AWA", "RTSP: client connected")
            mainHandler.post { _isPreviewActive.value = true }
        }
        override fun onConnectionFailed(reason: String) {
            Log.e("AWA", "RTSP: connection failed - $reason")
        }
        override fun onNewBitrate(bitrate: Long) { }
        override fun onDisconnect() {
            Log.d("AWA", "RTSP: client disconnected")
            mainHandler.post { _isPreviewActive.value = false }
        }
        override fun onAuthError() {
            Log.e("AWA", "RTSP: auth error")
        }
        override fun onAuthSuccess() {
            Log.d("AWA", "RTSP: auth success")
        }
    }

    fun attachPreviewSurface(context: Context, owner: LifecycleOwner, preview: PreviewView) {
        appContext = context.applicationContext
        lifecycleOwner = owner
        previewView = preview
        if (_streamMode.value == StreamMode.MJPEG) bindCamera()
    }

    fun attachRtspPreviewSurface(view: OpenGlView) {
        Log.d("AWA", "Attach rtsp preview called")
        openGlView = view
        try {
            rtspCamera?.replaceView(view)
            rtspCamera?.startPreview()
            _showLocalPreview.value = true
            startPreviewHideTimer()
        } catch (e: Exception) {
            Log.e("AWA", "RTSP replaceView(view) failed", e)
        }
    }

    fun detachRtspPreviewSurface() {
        val ctx = appContext
        val wasAttached = openGlView != null
        openGlView = null
        if (ctx != null && wasAttached) {
            try {
                if (rtspCamera?.isOnPreview == true) {
                    rtspCamera?.stopPreview()
                }
                rtspCamera?.replaceView(ctx)
            } catch (e: Exception) {
                Log.e("AWA", "RTSP replaceView(context) failed", e)
            }
        }
    }

    private fun startRtspCamera() {
        val ctx = appContext ?: return
        val s = _settings.value

        val camera = RtspServerCamera2(ctx, buildConnectChecker(), rtspPort)
        rtspCamera = camera

        val videoOk = try {
            camera.prepareVideo(s.resolution.size.width, s.resolution.size.height, 30, rtspBitrate, 0)
        } catch (e: Exception) {
            Log.e("AWA", "RTSP prepareVideo threw", e)
            false
        }
        val audioOk = camera.prepareAudio()
        Log.d("AWA", "RTSP prepareVideo=$videoOk prepareAudio=$audioOk")

        if (videoOk) {
            val flashAvailable = camera.cameraCharacteristics
                .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
            _settings.value = _settings.value.copy(hasFlashUnit = flashAvailable)

            // Refresh zoom range for the RTSP camera and re-apply stored zoom
            val zoomRange = runCatching { camera.getZoomRange() }.getOrNull()
            val maxZoom = zoomRange?.upper ?: _settings.value.zoomMax
            val minZoom = zoomRange?.lower ?: _settings.value.zoomMin
            val currentZoom = _settings.value.zoom.coerceIn(minZoom, maxZoom)
            _settings.value = _settings.value.copy(zoomMin = minZoom, zoomMax = maxZoom, zoom = currentZoom)
            if (currentZoom != 1f) {
                runCatching { camera.setZoom(currentZoom) }
                    .onFailure { Log.e("AWA", "RTSP zoom reapply failed", it) }
            }

            camera.startStream()
            Log.d("AWA", "RTSP server started on port $rtspPort")
            openGlView?.let { view ->
                try {
                    camera.replaceView(view)
                    camera.startPreview()
                } catch (e: Exception) {
                    Log.e("AWA", "RTSP replaceView during start failed", e)
                }
            }
        } else {
            Log.e("AWA", "RTSP: prepareVideo failed, not starting stream")
            rtspCamera = null
        }
    }

    private fun stopRtspCamera() {
        rtspCamera?.stopStream()
        rtspCamera = null
        _isPreviewActive.value = false
    }

    private fun restartRtspCamera(reason: String) {
        if (rtspCamera == null) return
        Log.d("AWA", "Restarting RTSP camera — reason: $reason")

        val viewToReattach = openGlView
        stopRtspCamera()
        startRtspCamera()

        if (viewToReattach != null && _showLocalPreview.value) {
            attachRtspPreviewSurface(viewToReattach)
        }
    }

    // --- MJPEG (CameraX) pipeline ---

    private fun bindCamera() {
        val ctx = appContext ?: return
        val owner = lifecycleOwner ?: return
        val preview = previewView ?: return
        val s = _settings.value

        val providerFuture = ProcessCameraProvider.getInstance(ctx)
        providerFuture.addListener({
            val provider = providerFuture.get()
            cameraProvider = provider

            val previewUseCase = Preview.Builder().build().also {
                it.setSurfaceProvider(preview.surfaceProvider)
            }

            val executor = cameraExecutor ?: Executors.newSingleThreadExecutor().also { cameraExecutor = it }

            val imageAnalysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setAspectRatioStrategy(
                            AspectRatioStrategy(s.resolution.aspectRatio, AspectRatioStrategy.FALLBACK_RULE_AUTO)
                        )
                        .setResolutionStrategy(
                            ResolutionStrategy(s.resolution.size, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
                        )
                        .build()
                )
                .build()
                .also {
                    it.setAnalyzer(executor) { imageProxy ->
                        try {
                            val width = imageProxy.width
                            val height = imageProxy.height
                            val nv21 = imageProxyToNv21(imageProxy)

                            if (jpegViewerCount.get() > 0) {
                                try {
                                    val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
                                    val out = ByteArrayOutputStream()
                                    yuvImage.compressToJpeg(Rect(0, 0, width, height), _settings.value.jpegQuality, out)
                                    val jpegBytes = out.toByteArray()
                                    currentFrame = jpegBytes
                                    VideoStreamServer.latestFrame = jpegBytes
                                } catch (e: Exception) {
                                    Log.e("AWA", "JPEG compression failed", e)
                                }
                            }
                        } catch (e: Exception) {
                            Log.e("AWA", "Analyzer callback failed", e)
                        } finally {
                            imageProxy.close()
                        }
                    }
                }

            val cameraSelector = CameraSelector.Builder()
                .requireLensFacing(s.lensFacing)
                .build()

            provider.unbindAll()
            val camera = provider.bindToLifecycle(owner, cameraSelector, previewUseCase, imageAnalysis)
            mjpegCamera = camera
            camera.cameraInfo.exposureState.let { exposureState ->
                _settings.value = _settings.value.copy(
                    exposureRange = exposureState.exposureCompensationRange.lower..exposureState.exposureCompensationRange.upper,
                    exposureIndex = exposureState.exposureCompensationIndex
                )
            }
            _settings.value = _settings.value.copy(
                hasFlashUnit = camera.cameraInfo.hasFlashUnit()  // add this field to CameraSettings
            )

            // Refresh zoom range for the bound camera and re-apply stored zoom
            val zoomState = camera.cameraInfo.zoomState.value
            val maxZoom = zoomState?.maxZoomRatio ?: _settings.value.zoomMax
            val minZoom = zoomState?.minZoomRatio ?: _settings.value.zoomMin
            val currentZoom = s.zoom.coerceIn(minZoom, maxZoom)
            _settings.value = _settings.value.copy(zoomMin = minZoom, zoomMax = maxZoom, zoom = currentZoom)
            if (currentZoom != 1f) {
                runCatching { camera.cameraControl.setZoomRatio(currentZoom) }
                    .onFailure { Log.e("AWA", "MJPEG zoom reapply failed", it) }
            }
        }, ContextCompat.getMainExecutor(ctx))
    }

    private fun unbindCamera() {
        cameraProvider?.unbindAll()
        cameraExecutor?.shutdown()
        cameraExecutor = null
        cameraProvider = null
        currentFrame = null
        mjpegCamera = null
        VideoStreamServer.latestFrame = null
    }

    private fun imageProxyToNv21(image: androidx.camera.core.ImageProxy): ByteArray {
        val width = image.width
        val height = image.height
        val ySize = width * height
        val uvSize = width * height / 2
        val nv21 = ByteArray(ySize + uvSize)

        val yBuffer = image.planes[0].buffer
        val uBuffer = image.planes[1].buffer
        val vBuffer = image.planes[2].buffer

        val yRowStride = image.planes[0].rowStride
        val uvRowStride = image.planes[1].rowStride
        val uvPixelStride = image.planes[1].pixelStride

        var outputOffset = 0
        if (yRowStride == width) {
            yBuffer.get(nv21, 0, ySize)
            outputOffset = ySize
        } else {
            var yOffset = 0
            for (i in 0 until height) {
                yBuffer.position(yOffset)
                yBuffer.get(nv21, outputOffset, width)
                outputOffset += width
                yOffset += yRowStride
            }
        }

        val uvHeight = height / 2
        val uvWidth = width / 2

        for (row in 0 until uvHeight) {
            for (col in 0 until uvWidth) {
                val uvIndex = row * uvRowStride + col * uvPixelStride
                nv21[outputOffset++] = vBuffer.get(uvIndex)
                nv21[outputOffset++] = uBuffer.get(uvIndex)
            }
        }

        return nv21
    }

    // --- Focus ---

    fun toggleFocusMode() {
        val newMode = if (_settings.value.focusMode == FocusMode.AUTO) FocusMode.MANUAL else FocusMode.AUTO
        _settings.value = _settings.value.copy(focusMode = newMode)
        if (newMode == FocusMode.MANUAL) {
            applyManualFocus(_settings.value.focusDistance)
        } else {
            cancelFocusAndMetering()
        }
    }

    fun setFocusDistance(distance: Float) {
        _settings.value = _settings.value.copy(focusDistance = distance)
        if (_settings.value.focusMode == FocusMode.MANUAL) {
            applyManualFocus(distance)
        }
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun applyManualFocus(dist: Float) {
        Log.d("AWA","$dist")
        val distance = 1f - dist
        if (_streamMode.value == StreamMode.MJPEG) {
            val currentCamera = mjpegCamera ?: return
            val camera2Info = Camera2CameraInfo.from(currentCamera.cameraInfo)
            val minFocusDistance = camera2Info.getCameraCharacteristic(
                CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE
            ) ?: 0f

            if (minFocusDistance == 0f) return

            val focusDiopters = distance * minFocusDistance
            val camera2Control = Camera2CameraControl.from(currentCamera.cameraControl)
            val options = CaptureRequestOptions.Builder()
                .setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
                .setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, focusDiopters)
                .build()

            camera2Control.setCaptureRequestOptions(options)
        } else {
            val currentCamera = rtspCamera ?: return
            val minFocusDistance = currentCamera.cameraCharacteristics.get(
                CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE
            ) ?: 0f

            if (minFocusDistance == 0f) return

            if (currentCamera.isAutoFocusEnabled) {
                currentCamera.disableAutoFocus()
            }
            Log.d("AWA", "AutoFocus state: ${currentCamera.isAutoFocusEnabled}")
            currentCamera.setFocusDistance(distance * minFocusDistance)
        }
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun cancelFocusAndMetering() {
        if (_streamMode.value == StreamMode.MJPEG) {
            val currentCamera = mjpegCamera ?: return
            val camera2Control = Camera2CameraControl.from(currentCamera.cameraControl)
            camera2Control.clearCaptureRequestOptions()
            currentCamera.cameraControl.cancelFocusAndMetering()
        } else {
            var focus = rtspCamera?.isAutoFocusEnabled
            Log.d("AWA", "RTSP cancel manual , Autofocus before : $focus")
            rtspCamera?.enableAutoFocus()
            focus = rtspCamera?.isAutoFocusEnabled
            Log.d("AWA", "RTSP cancel manual , Autofocus after: $focus")
        }
    }

    fun tapToFocus(x: Float, y: Float, width: Float, height: Float) {
        val cameraControl = mjpegCamera?.cameraControl ?: return
        _settings.value = _settings.value.copy(focusMode = FocusMode.AUTO)

        val factory = SurfaceOrientedMeteringPointFactory(width, height)
        val point = factory.createPoint(x, y)
        val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF)
            .setAutoCancelDuration(3, TimeUnit.SECONDS)
            .build()

        cameraControl.startFocusAndMetering(action)
    }

    fun tapToFocus(view: View, event: MotionEvent) {
        _settings.value = _settings.value.copy(focusMode = FocusMode.AUTO)
        rtspCamera?.tapToFocus(view, event)
    }

    fun switchCamera() {
        val newFacing = if (_settings.value.lensFacing == CameraSelector.LENS_FACING_BACK)
            CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK
        _settings.value = _settings.value.copy(lensFacing = newFacing)

        when (_streamMode.value) {
            StreamMode.MJPEG -> bindCamera() // already re-derives hasFlashUnit via its callback
            StreamMode.H264_RTSP -> {
                try {
                    rtspCamera?.switchCamera()
                    val flashAvailable = rtspCamera?.cameraCharacteristics
                        ?.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
                    _settings.value = _settings.value.copy(hasFlashUnit = flashAvailable)
                    Log.d("AWA", "RTSP switchCamera successful")
                } catch (e: Exception) {
                    Log.e("AWA", "RTSP switchCamera failed", e)
                }
            }
        }
    }

    fun setCameraFacing(back: Boolean) {
        val target = if (back) CameraSelector.LENS_FACING_BACK else CameraSelector.LENS_FACING_FRONT
        if (_settings.value.lensFacing == target) return
        applyCameraFacing(target)
    }

    private fun applyCameraFacing(facing: Int) {
        _settings.value = _settings.value.copy(lensFacing = facing)
        when (_streamMode.value) {
            StreamMode.MJPEG -> bindCamera()
            StreamMode.H264_RTSP -> {
                try {
                    rtspCamera?.switchCamera()
                } catch (e: Exception) {
                    Log.e("AWA", "RTSP switchCamera failed", e)
                }
            }
        }
    }

    fun toggleFlash() {
        val targetState = !_settings.value.isFlashEnabled
        _settings.value = _settings.value.copy(isFlashEnabled = targetState)
        applyFlash(targetState)
    }

    fun applyFlash(enable: Boolean) {
        when (_streamMode.value) {
            StreamMode.MJPEG -> {
                mjpegCamera?.let { camera ->
                    if (camera.cameraInfo.hasFlashUnit()) {
                        camera.cameraControl.enableTorch(enable)
                    } else {
                        Log.w("AWA", "MJPEG: Device has no flash unit")
                    }
                }
            }

            StreamMode.H264_RTSP -> {
                rtspCamera?.let { camera ->
                    try {
                        if (enable) {
                            camera.enableLantern()
                        } else {
                            camera.disableLantern()
                        }
                        Log.d("AWA", "RTSP Lantern active: ${camera.isLanternEnabled}")
                    } catch (e: Exception) {
                        Log.e("AWA", "Failed to toggle RTSP lantern", e)
                    }
                }
            }
        }
    }

    fun setResolution(res: StreamResolution) {
        _settings.value = _settings.value.copy(resolution = res)
        when (_streamMode.value) {
            StreamMode.MJPEG -> {
                if (cameraProvider != null) bindCamera()
            }
            StreamMode.H264_RTSP -> restartRtspCamera("resolution changed to ${res.label}")
        }
    }

    fun setQuality(quality: Int) {
        _settings.value = _settings.value.copy(jpegQuality = quality)
    }

    fun setZoom(zoom: Float) {
        val (minZoom, maxZoom) = getZoomRange()
        val clamped = zoom.coerceIn(minZoom, maxZoom)
        if (_settings.value.zoom == clamped) return
        _settings.value = _settings.value.copy(zoom = clamped)
        applyZoom(clamped)
    }

    fun pinchZoom(zoomChange: Float) {
        if (zoomChange <= 0f || zoomChange.isNaN()) return
        setZoom(_settings.value.zoom * zoomChange)
    }

    fun getMaxZoom(): Float {
        val live = when (_streamMode.value) {
            StreamMode.MJPEG -> mjpegCamera?.cameraInfo?.zoomState?.value?.maxZoomRatio
            StreamMode.H264_RTSP -> runCatching { rtspCamera?.getZoomRange()?.upper }.getOrNull()
        }
        val resolved = live ?: _settings.value.zoomMax
        return if (resolved > 1f) resolved else _settings.value.zoomMax
    }

    fun getMinZoom(): Float {
        val live = when (_streamMode.value) {
            StreamMode.MJPEG -> mjpegCamera?.cameraInfo?.zoomState?.value?.minZoomRatio
            StreamMode.H264_RTSP -> runCatching { rtspCamera?.getZoomRange()?.lower }.getOrNull()
        }
        val resolved = live ?: _settings.value.zoomMin
        return if (resolved <= 1f) resolved else 1f
    }

    fun getZoomRange(): Pair<Float, Float> {
        val min = getMinZoom()
        val max = getMaxZoom()
        return min to maxOf(max, min)
    }

    private fun applyZoom(zoom: Float) {
        when (_streamMode.value) {
            StreamMode.MJPEG -> runCatching {
                mjpegCamera?.cameraControl?.setZoomRatio(zoom)
            }.onFailure { Log.e("AWA", "MJPEG setZoomRatio failed", it) }
            StreamMode.H264_RTSP -> runCatching {
                rtspCamera?.setZoom(zoom)
            }.onFailure { Log.e("AWA", "RTSP setZoom failed", it) }
        }
    }

    fun setExposure(index: Int) {
        if (_streamMode.value == StreamMode.MJPEG) {
            mjpegCamera?.cameraControl?.setExposureCompensationIndex(index)
        } else {
            rtspCamera?.exposure = index
        }
        _settings.value = _settings.value.copy(exposureIndex = index)
    }

    override fun onCleared() {
        hideLocalPreview()
        unbindCamera()
        stopRtspCamera()
    }
}