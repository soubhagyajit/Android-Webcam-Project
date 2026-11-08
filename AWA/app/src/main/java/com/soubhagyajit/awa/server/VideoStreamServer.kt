package com.soubhagyajit.awa.server

import android.util.Log
import com.soubhagyajit.awa.viewModel.CameraViewModel
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.cio.*
import io.ktor.server.http.content.staticResources
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.request.receive
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.OutputStream

object VideoStreamServer {

    @Serializable
    data class FeaturesResponse(
        val resolutions: List<String>,
        val manual_focus: Boolean,
        val exposure_lower: Int,
        val exposure_upper: Int,
        val has_zoom: Boolean,
        val zoom_max: Float,
        val zoom_min: Float,
        val stream_protocol: CameraViewModel.StreamMode,
        val server_port: Int? = null,
        val rtsp_port: Int? = null
    )

    @Serializable
    data class SettingsResponse(
        val camera: String,
        val resolution_str: String,
        val zoom: Float,
        val focus_mode: Int,
        val focus_distance: Float,
        val exposure_index: Int,
        val autofocus: Boolean? = null,
        val stream_quality: Int,
        val flash: Boolean = false,
        val has_flash_unit: Boolean? = null,
    )

    @Serializable
    data class SettingsUpdateRequest(
        val focus_mode: Int? = null,
        val focus_distance: Float? = null,
        val autofocus: Boolean? = null,
        val exposure_index: Int? = null,
        val zoom: Float? = null,
        val flash: Boolean? = null,
        val resolution_str: String? = null,
        val switchCamera: Boolean? = null,
        val camera: String,
        val stream_quality: Int? = null,
    )

    var featuresProvider: (() -> FeaturesResponse)? = null
    var settingsProvider: (() -> SettingsResponse)? = null

    // Returns null on success, or an error message String if rejected
    var onSettingsUpdated: ((SettingsUpdateRequest) -> String?)? = null

    private var server: EmbeddedServer<*, *>? = null
    @Volatile
    var latestFrame: ByteArray? = null

    var onUserConnected: (() -> Unit)? = null
    var onUserDisconnected: (() -> Unit)? = null
    var onServerStateChanged: ((Boolean) -> Unit)? = null

    val isRunning: Boolean
        get() = server != null

    fun toggleServer(port: Int = 8080) {
        if (isRunning) {
            stop()
        } else {
            start(port)
        }
        onServerStateChanged?.invoke(isRunning)
    }

    fun start(port: Int = 8080) {
        if (server != null) return

        server = embeddedServer(CIO, port = port) {
            install(ContentNegotiation) {
                json(
                    Json {
                        prettyPrint = true
                        ignoreUnknownKeys = true
                    }
                )
            }
            install(CORS) {
                anyHost()
                allowMethod(HttpMethod.Get)
                allowMethod(HttpMethod.Post)
                allowHeader(HttpHeaders.ContentType)
            }
            routing {
                get("/video") {
                    onUserConnected?.invoke()
                    try {
                        call.respondOutputStream(
                            contentType = ContentType.parse("multipart/x-mixed-replace; boundary=--frame"),
                            status = HttpStatusCode.OK
                        ) {
                            streamMjpeg(this)
                        }
                    } finally {
                        onUserDisconnected?.invoke()
                    }
                }

                get("/features") {
                    val response = featuresProvider?.invoke() ?: FeaturesResponse(
                        resolutions = listOf("640x480", "1280x720", "1920x1080"),
                        manual_focus = false,
                        exposure_upper = 0,
                        exposure_lower = 0,
                        has_zoom = false,
                        zoom_max = 1.0f,
                        zoom_min = 1.0f,
                        stream_protocol = CameraViewModel.StreamMode.MJPEG,
                        server_port = null,
                        rtsp_port = null
                    )
                    call.respond(response)
                }

                get("/settings") {
                    val response = settingsProvider?.invoke() ?: SettingsResponse(
                        camera = "back",
                        resolution_str = "1280x720",
                        zoom = 1.0f,
                        flash = false,
                        exposure_index = 1,
                        autofocus = true,
                        focus_mode = 0,
                        focus_distance = 0f,
                        has_flash_unit = false,
                        stream_quality = 80,
                    )
                    call.respond(response)
                }

                // POST Endpoint
                post("/settings") {
                    try {
                        val request = call.receive<SettingsUpdateRequest>()
                        val error = onSettingsUpdated?.invoke(request)
                        if (error != null) {
                            call.respond(HttpStatusCode.BadRequest, mapOf("error" to error))
                        } else {
                            call.respond(HttpStatusCode.OK, mapOf("status" to "success"))
                        }
                    } catch (e: Exception) {
                        call.respond(HttpStatusCode.BadRequest, mapOf("error" to (e.message ?: "Invalid payload")))
                    }
                }

                // GET Endpoint
                get("/control") {
                    val params = call.request.queryParameters
                    Log.d("AWA", "$params")
                    val update = SettingsUpdateRequest(
                        camera = params["camera"] ?: "back",
                        resolution_str = params["resolution_str"],
                        zoom = params["zoom"]?.toFloatOrNull(),
                        flash = params["flash"]?.toBooleanStrictOrNull(),
                        exposure_index = params["exposure_index"]?.toIntOrNull(),
                        autofocus = params["autofocus"]?.toBooleanStrictOrNull(),
                        focus_mode = params["focus_mode"]?.toIntOrNull(),
                        focus_distance = params["focus_distance"]?.toFloatOrNull(),
                        switchCamera = if (params.contains("switch_camera")) true else null,
                        stream_quality = 80,
                    )

                    val error = onSettingsUpdated?.invoke(update)
                    if (error != null) {
                        call.respond(HttpStatusCode.BadRequest, mapOf("error" to error))
                    } else {
                        val response = settingsProvider?.invoke() ?: SettingsResponse(
                            focus_mode = 0, focus_distance = 0f, exposure_index = 1,
                            zoom = 1.0f, stream_quality = 80, resolution_str = "1280x720",
                            camera = "back"
                        )
                        call.respond(HttpStatusCode.OK, response)
                    }
                }
                staticResources("/static", "static")
                get("/help"){
                    call.respondRedirect("/static/help.html")
                }

            }
        }.start(wait = false)
    }

    private suspend fun streamMjpeg(outputStream: OutputStream) {
        val boundary = "\r\n--frame\r\n".toByteArray()
        val contentType = "Content-Type: image/jpeg\r\n".toByteArray()

        // CHANGED: only send frames that are new. The old loop re-sent the same latest frame
        // every 33 ms, so a slow camera (or slow link) still pushed ~30 full JPEGs per second.
        var lastSent: ByteArray? = null
        var frames = 0
        var bytes = 0L
        var windowStart = System.nanoTime()

        while (true) {
            val frame = latestFrame
            if (frame != null && frame !== lastSent) {
                try {
                    withContext(Dispatchers.IO) {
                        outputStream.write(boundary)
                        outputStream.write(contentType)
                        outputStream.write("Content-Length: ${frame.size}\r\n\r\n".toByteArray())
                        outputStream.write(frame)
                        outputStream.flush()
                    }
                } catch (_: Exception) {
                    break
                }
                lastSent = frame
                frames++
                bytes += frame.size

                val now = System.nanoTime()
                if (now - windowStart >= 2_000_000_000L) {
                    val secs = (now - windowStart) / 1e9
                    Log.d("AWA", "MJPEG out: ${"%.1f".format(frames / secs)} fps, ${(bytes / 1024 / secs).toLong()} KB/s")
                    frames = 0
                    bytes = 0L
                    windowStart = now
                }
            } else {
                delay(5)
            }
        }
    }

    fun stop() {
        server?.stop(1000, 2000)
        server = null
    }
}