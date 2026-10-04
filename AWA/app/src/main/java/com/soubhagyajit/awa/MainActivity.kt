package com.soubhagyajit.awa

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.soubhagyajit.awa.ui.theme.AWATheme
import com.soubhagyajit.awa.ui.components.Preview
import com.soubhagyajit.awa.viewModel.CameraViewModel
import java.net.Inet4Address
import java.net.NetworkInterface

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep the screen on (no sleep/lock) while the camera server is running in the foreground
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.statusBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        enableEdgeToEdge()
        setContent {
            AWATheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    CameraScreen()
                }
            }
        }
    }
}
@Composable
fun CameraScreen(camView: CameraViewModel = viewModel()) {
    // Check for both Camera & Audio permissions needed for streaming
    val hasPermission by checkPermissions(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.INTERNET
    )

    if (hasPermission) {
        // Render Camera Preview / Streaming controls here
        CameraContent(camView)
    } else {
        // Fallback UI shown while asking or if user denies permissions
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            Text("Camera and Audio permissions are required to stream.")
        }
    }
}

@Composable
private fun CameraContent(camView: CameraViewModel) {
    val isServerRunning by camView.isServerRunning
    val isPreviewActive by camView.isPreviewActive
    val showLocalPreview by camView.showLocalPreview

    var isSettingsOpen by remember { mutableStateOf(false) }

    val context = LocalContext.current

    val streamMode by camView.streamMode
    var showExposureSlider by remember { mutableStateOf(false) }

    val settings by camView.settings
    val exposureIndex = settings.exposureIndex
    val exposureRange = settings.exposureRange
    val focusMode = settings.focusMode
    val focusDistance = settings.focusDistance
    var showFocusSlider by remember { mutableStateOf(false) }
    var showZoomSlider by remember { mutableStateOf(false) }
    val ipAddress by remember { mutableStateOf(getLocalIpAddress()) }

    // Blank-screen state: draws an opaque black overlay (burn-in safe) and dims the
    // backlight, without ever letting the display actually sleep or lock.
    var isScreenBlanked by remember { mutableStateOf(false) }

    LaunchedEffect(isScreenBlanked) {
        (context as? Activity)?.window?.let { win ->
            win.attributes = win.attributes.apply {
                screenBrightness = if (isScreenBlanked) {
                    0.0f
                } else {
                    WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                }
            }
        }
    }

    LaunchedEffect (Unit) {
        camView.initialize(context)
    }

    Box(modifier = Modifier.fillMaxSize()) {

        //Camera Preview

        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTapGestures { offset ->
                        camView.notifyScreenTapped()
                        camView.tapToFocus(
                            x = offset.x,
                            y = offset.y,
                            width = size.width.toFloat(),
                            height = size.height.toFloat()
                        )
                    }
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, _, zoomChange, _ ->
                        camView.pinchZoom(zoomChange)
                    }
                }
        ) {
            Preview(
                camView,
                Modifier
                    .fillMaxSize()
                    .alpha(if (showLocalPreview) 1f else 0f)
            )

            if (!showLocalPreview) {
                val message = when {
                    !isServerRunning -> "Server Stopped"
                    streamMode == CameraViewModel.StreamMode.H264_RTSP && isPreviewActive -> "Client connected — tap to preview"
                    streamMode == CameraViewModel.StreamMode.H264_RTSP -> "Waiting for client... (tap to preview)"
                    isPreviewActive -> "Client connected — tap to preview"
                    else -> "No client connected. (tap to preview)"
                }
                Box(
                    Modifier.fillMaxSize().background(Color.Black),
                    contentAlignment = Alignment.Center
                ) {
                    Text(message)
                }
            }
        }
        //Top Controls
        Row (
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ){
            Row (modifier = Modifier, verticalAlignment = Alignment.CenterVertically , horizontalArrangement = Arrangement.spacedBy(16.dp)){
                Box {
                    TextButton(
                        onClick = {
                            showExposureSlider = !showExposureSlider
                            showZoomSlider = false
                            Log.d("AWA", "Exposure button tapped")
                        }
                    ) {
                        Text("EXP")
                    }

                    if (showExposureSlider) {
                        Popup (alignment = Alignment.TopStart, offset = IntOffset(0, 120),  onDismissRequest = { showExposureSlider = false }) {
                            Box(
                                modifier = Modifier
                                    .background(Color(0xCC1A1A1A), shape = RoundedCornerShape(8.dp))
                                    .padding(12.dp)
                            ) {
                                Slider(
                                    value = exposureIndex.toFloat(),
                                    onValueChange = { camView.setExposure(it.toInt()) },
                                    valueRange = exposureRange.first.toFloat()..exposureRange.last.toFloat(),
                                    modifier = Modifier.width(400.dp)
                                )
                            }
                        }
                    }
                }
                Box {
                    TextButton(
                        onClick = {
                            showZoomSlider = !showZoomSlider
                            showExposureSlider = false
                            Log.d("AWA", "Zoom button tapped")
                        }
                    ) {
                        Text("ZOOM")
                    }

                    if (showZoomSlider) {
                        Popup (alignment = Alignment.TopStart, offset = IntOffset(0, 120),  onDismissRequest = { showZoomSlider = false }) {
                            Box(
                                modifier = Modifier
                                    .background(Color(0xCC1A1A1A), shape = RoundedCornerShape(8.dp))
                                    .padding(12.dp)
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("Zoom ${"%.1f".format(settings.zoom)}x", color = Color.White, fontSize = 12.sp)
                                    Slider(
                                        value = settings.zoom,
                                        onValueChange = { camView.setZoom(it) },
                                        valueRange = settings.zoomMin..maxOf(settings.zoomMax, settings.zoomMin + 0.1f),
                                        modifier = Modifier.width(300.dp)
                                    )
                                }
                            }
                        }
                    }
                }
                Box {
                    SmallFloatingActionButton(
                        onClick = {
                            Log.d("AWA", "Focus button tapped")
                            camView.toggleFocusMode()
                            showFocusSlider = (settings.focusMode == CameraViewModel.FocusMode.MANUAL)
                        },
                        shape = CircleShape,
                        modifier = Modifier.size(36.dp)
                    ) {
                        Text(
                            text = if (focusMode == CameraViewModel.FocusMode.AUTO) "A" else "M",
                            fontSize = 16.sp
                        )
                    }
                    if (focusMode == CameraViewModel.FocusMode.MANUAL && showFocusSlider) {
                        Popup(
                            alignment = Alignment.TopStart,
                            offset = IntOffset(0, 120),
                            onDismissRequest = { showFocusSlider = false }) {
                            Box(
                                modifier = Modifier
                                    .background(Color(0xCC1A1A1A), shape = RoundedCornerShape(8.dp))
                                    .padding(12.dp)
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("Focus Distance", color = Color.White, fontSize = 12.sp)
                                    Slider(
                                        value = focusDistance,
                                        onValueChange = { camView.setFocusDistance(it) },
                                        valueRange = 0f..1f,
                                        modifier = Modifier.width(300.dp)
                                    )
                                }
                            }
                        }
                    }
                }
                Box {
                    SmallFloatingActionButton(
                        onClick = {
                            Log.d("AWA", "Flash button tapped")
                            camView.toggleFlash()
                        },
                        shape = CircleShape,
                        modifier = Modifier.size(36.dp)
                    ) {
                        if (settings.isFlashEnabled){
                            Icon(Icons.Default.FlashOff, contentDescription = "Flash", Modifier.size(24.dp), tint = Color.White)
                        }
                        else{
                            Icon(Icons.Default.FlashOn, contentDescription = "Flash", Modifier.size(24.dp), tint = Color.White)
                        }

                    }
                }
                Box {
                    TextButton(
                        onClick = {
                            isScreenBlanked = true
                            Log.d("AWA", "Screen blanked")
                        }
                    ) {
                        Text("DIM")
                    }
                }
            }
            Row (verticalAlignment = Alignment.CenterVertically){
                if (isServerRunning)

                    Box (modifier = Modifier, contentAlignment = Alignment.Center){
                        Text("IP : ${ipAddress}:${ if (streamMode == CameraViewModel.StreamMode.H264_RTSP) 8554 else 8080 }",modifier = Modifier.padding(4.dp))
                    }
                if (isServerRunning)
                    Icon(Icons.Default.Link, contentDescription = "Server Status", tint = Color.Green,modifier = Modifier.padding(horizontal = 2.dp))
                else
                    Icon(Icons.Default.Link, contentDescription = "Server Status", tint = Color.Red,modifier = Modifier.padding(horizontal = 2.dp))
            }
        }

        //Bottom Controls
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Left slot
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                IconButton(onClick = {
                    isSettingsOpen = true
                    Log.d("AWA", "Settings button tapped")
                }) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color.White)
                }
            }

            // Center slot — the shutter, fixed size, not weighted
            FilledTonalButton (
                onClick = { camView.toggleServer()
//                    Log.d("AWA","Server button toggled, server status: "+camView.isServerRunning)
                },
                contentPadding = PaddingValues(12.dp)
            ){
                Icon (
                    imageVector = if (isServerRunning) Icons.Default.PowerSettingsNew else Icons.Default.PowerSettingsNew,
                    contentDescription = if (isServerRunning) "Stop server" else "Start server",
                    tint = if (isServerRunning) Color.Green else Color.Red,
                    modifier = Modifier.size(32.dp)
                )
            }

            // Right slot
            Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                IconButton(onClick = { camView.switchCamera() }) {
                    Icon(Icons.Default.Cameraswitch, contentDescription = "Flip Camera", tint = Color.White)
                }
            }
        }

        // Burn-in-safe blank screen: opaque black, tap anywhere to restore controls & brightness
        if (isScreenBlanked) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black)
                    .pointerInput(Unit) {
                        detectTapGestures {
                            isScreenBlanked = false
                        }
                    }
            )
        }

    }
    SettingsPanel(
        isOpen = isSettingsOpen,
        onClose = { isSettingsOpen = false },
        camView = camView,
        modifier = Modifier.fillMaxSize(),
        settings
    )
}

@Preview(name = "Idle", showBackground = true, uiMode = Configuration.ORIENTATION_LANDSCAPE)
@Composable
fun CameraScreenPreview() {
    CameraScreen()
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsPanel(
    isOpen: Boolean,
    onClose: () -> Unit,
    camView: CameraViewModel,
    modifier: Modifier = Modifier,
    settings: CameraViewModel.CameraSettings
) {
    val configuration = LocalConfiguration.current
    val isLandscape = configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val quality = settings.jpegQuality
    var sliderPosition by remember { mutableFloatStateOf(quality.toFloat()) }
    val streamMode by camView.streamMode
    val scrollState = rememberScrollState()
    val context = LocalContext.current

    AnimatedVisibility(
        visible = isOpen,
        enter = slideInHorizontally(initialOffsetX = { it }),
        exit = slideOutHorizontally(targetOffsetX = { it }),
        modifier = modifier
    ) {
        Box {
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .then(if (isLandscape) Modifier.fillMaxWidth(0.5f) else Modifier.fillMaxWidth())
                    .align(Alignment.CenterEnd)
                    .background(Color(0xCC1A1A1A))
                    .systemBarsPadding()
                    .padding(24.dp)
            ) {
                Column(modifier = Modifier.fillMaxSize()) {

                    // Fixed header
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("Settings", color = Color.White, style = MaterialTheme.typography.titleLarge)
                        IconButton(onClick = onClose) {
                            Icon(Icons.Default.Close, contentDescription = "Close", tint = Color.White)
                        }
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    // Scrollable settings, takes all remaining space
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .verticalScroll(scrollState)
                    ) {
                        StreamTypeSelector(camView = camView)

                        Spacer(modifier = Modifier.height(16.dp))

                        ResolutionDropdown(camView = camView, settings = settings)

                        Spacer(modifier = Modifier.height(16.dp))

                        if (streamMode == CameraViewModel.StreamMode.MJPEG) {
                            Text("Quality: ${sliderPosition.toInt()}", color = Color.White)
                            Spacer(modifier = Modifier.height(16.dp))
                            Slider(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(24.dp),
                                value = sliderPosition,
                                onValueChange = { sliderPosition = it },
                                onValueChangeFinished = { camView.setQuality(sliderPosition.toInt()) },
                                valueRange = 10f..100f,
                                track = { state ->
                                    SliderDefaults.Track(
                                        sliderState = state,
                                        modifier = Modifier.height(6.dp)
                                    )
                                }
                            )
                            Spacer(modifier = Modifier.height(16.dp))
                        }
                    }

                    // Fixed footer, always visible
                    TextButton(
                        onClick = {
                            context.startActivity(Intent(context, HelpActivity::class.java))
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.AutoMirrored.Filled.HelpOutline, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("API Help & Info")
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StreamTypeSelector(camView: CameraViewModel) {
    val streamMode by camView.streamMode
    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it }
    ) {
        OutlinedTextField(
            value = streamMode.label,
            onValueChange = {},
            readOnly = true,
            label = { Text("Stream Type") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor()
                .fillMaxWidth()
        )

        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            CameraViewModel.StreamMode.entries.forEach { mode ->
                DropdownMenuItem(
                    text = { Text(mode.label) },
                    onClick = {
                        camView.setStreamMode(mode)
                        Log.d("AWA", "Stream mode set to ${mode.label}")
                        expanded = false
                    }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResolutionDropdown(camView: CameraViewModel, settings: CameraViewModel.CameraSettings) {
    val currentResolution = settings.resolution
    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox (
        expanded = expanded,
        onExpandedChange = { expanded = it }
    ) {
        OutlinedTextField(
            value = currentResolution.label,
            onValueChange = {},
            readOnly = true,
            label = { Text("Resolution") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor()
                .fillMaxWidth()
        )

        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            CameraViewModel.StreamResolution.entries.forEach { res ->
                DropdownMenuItem(
                    text = { Text(res.label) },
                    onClick = {
                        camView.setResolution(res)
                        Log.d("AWA", "Resolution set to ${res.label}:${res.size}")
                        expanded = false
                    }
                )
            }
        }
    }
}
fun getLocalIpAddress(): String? {
    try {
        val interfaces = NetworkInterface.getNetworkInterfaces()
        for (networkInterface in interfaces) {
            if (!networkInterface.isUp || networkInterface.isLoopback) continue
            for (address in networkInterface.inetAddresses) {
                if (address is Inet4Address && !address.isLoopbackAddress) {
                    return address.hostAddress
                }
            }
        }
    } catch (e: Exception) {
        Log.e("AWA", "Failed to get IP", e)
    }
    return null
}
@Composable
fun checkPermissions(
    vararg permissions: String = arrayOf(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO
    )
): State<Boolean> {
    val context = LocalContext.current
    val isPreview = LocalInspectionMode.current

    // In Compose Preview, mock granted permissions to avoid preview runtime crashes
    if (isPreview) {
        return remember { mutableStateOf(true) }
    }

    fun isAllGranted() = permissions.all { permission ->
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    val hasPermissions = remember(permissions) {
        mutableStateOf(isAllGranted())
    }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        hasPermissions.value = results.values.all { it }
    }

    LaunchedEffect(permissions) {
        if (!hasPermissions.value) {
            launcher.launch(permissions.toList().toTypedArray())
        }
    }

    return hasPermissions
}