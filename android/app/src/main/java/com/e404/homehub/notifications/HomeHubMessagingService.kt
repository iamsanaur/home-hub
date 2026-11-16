package com.e404.homehub.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.e404.homehub.AppGraph
import com.e404.homehub.MainActivity
import com.e404.homehub.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch

object Channels {
    const val HOUSEHOLD = "household"
    const val APPROVALS = "approvals"
    fun create(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(HOUSEHOLD, context.getString(R.string.notification_channel_household), NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(APPROVALS, context.getString(R.string.notification_channel_approvals), NotificationManager.IMPORTANCE_HIGH))
    }
}

/** FCM: token refresh re-registers the device with the gateway; messages open deep links. */
class HomeHubMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val graph = AppGraph.get(this)
        if (graph.auth.currentUser == null) return
        graph.scope.launch { runCatching { graph.session.registerDevice(DeviceId.get(this@HomeHubMessagingService), token, appVersion()) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification ?: return
        val link = message.data["deepLink"].orEmpty().ifEmpty { "homehub://home" }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link), this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(this, link.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val channel = if (message.data["category"] == "approvals") Channels.APPROVALS else Channels.HOUSEHOLD
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle(n.title).setContentText(n.body).setAutoCancel(true).setContentIntent(pi)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify(message.data["notificationId"]?.hashCode() ?: link.hashCode(), notification) }
    }

    private fun appVersion() = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "1.0"
}

object DeviceId {
    fun get(context: Context): String {
        val prefs = context.getSharedPreferences("homehub_device", Context.MODE_PRIVATE)
        return prefs.getString("id", null) ?: java.util.UUID.randomUUID().toString().replace("-", "").also { prefs.edit().putString("id", it).apply() }
    }
}
