package com.soubhagyajit.awa.server

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log

object AwaDiscovery {
    private var nsd: NsdManager? = null
    private var listener: NsdManager.RegistrationListener? = null

    fun register(context: Context, port: Int, protocol: String) {
        if (listener != null) return
        val info = NsdServiceInfo().apply {
            serviceName = "AWA-${Build.MODEL}"
            serviceType = "_awa._tcp."
            setPort(port)
            setAttribute("proto", protocol)   // "MJPEG" or "RTSP"
            setAttribute("ver", "1")
        }
        listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo?) {Log.d("AWA", "NSD registered: ${i?.serviceName}")}
            override fun onRegistrationFailed(i: NsdServiceInfo?, e: Int){ Log.e("AWA", "NSD reg failed $e") }
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
        }
        nsd = (context.getSystemService(Context.NSD_SERVICE) as NsdManager).also {
            it.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        }
    }

    fun unregister() {
        listener?.let { runCatching { nsd?.unregisterService(it) } }
        listener = null
    }
}