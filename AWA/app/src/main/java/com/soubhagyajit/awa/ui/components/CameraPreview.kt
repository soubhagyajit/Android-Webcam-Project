package com.soubhagyajit.awa.ui.components

import android.util.Log
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceHolder
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.camera.view.PreviewView
import com.pedro.library.view.OpenGlView
import com.soubhagyajit.awa.viewModel.CameraViewModel

@Composable
fun Preview(
    viewModel: CameraViewModel,
    modifier: Modifier = Modifier
) {
    val streamMode by viewModel.streamMode
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    if (streamMode == CameraViewModel.StreamMode.MJPEG) {

        AndroidView(
            factory = { ctx ->
                PreviewView(ctx).apply {
                    viewModel.attachPreviewSurface(
                        context,
                        lifecycleOwner,
                        this
                    )
                }
            }
        )

    } else {

        // Create ONLY ONE OpenGlView for this composition
        val openGlView = remember {
            OpenGlView(context)
        }

        val isPinching = remember { mutableStateOf(false) }

        val scaleDetector = remember {
            ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                    isPinching.value = true
                    return true
                }

                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    viewModel.pinchZoom(detector.scaleFactor)
                    return true
                }
            })
        }

        AndroidView(
            factory = {
                openGlView.apply {
                    setOnTouchListener { view, event ->
                        scaleDetector.onTouchEvent(event)
                        if (event.action == MotionEvent.ACTION_UP) {
                            if (!isPinching.value) {
                                viewModel.tapToFocus(view, event)
                                viewModel.notifyScreenTapped()
                            }
                            isPinching.value = false
                        }
                        true
                    }
                    holder.addCallback(object : SurfaceHolder.Callback {
                        override fun surfaceCreated(holder: SurfaceHolder) {
                            Log.d("AWA", "Attach preview called")
                            viewModel.attachRtspPreviewSurface(this@apply)
                        }

                        override fun surfaceChanged(
                            holder: SurfaceHolder,
                            format: Int,
                            width: Int,
                            height: Int
                        ) {}

                        override fun surfaceDestroyed(holder: SurfaceHolder) {
                            viewModel.detachRtspPreviewSurface()
                        }
                    })
                }

            }
        )

        DisposableEffect(Unit) {
            onDispose {
                viewModel.detachRtspPreviewSurface()
            }
        }
    }
}