package com.e404.homehub.ui.components

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space

private const val PREFS = "homehub.notifications"
private const val DISMISSED = "promptDismissed"
private const val ASKED = "permissionAsked"

/**
 * Contextual ask for notification permission (Android 13+ needs a runtime grant). Shown on Home
 * until notifications are on or the person chooses "Not now". If the system will no longer show
 * its dialog (denied before), "Turn on" opens the app's notification settings instead.
 */
@Composable
fun NotificationPrompt(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var enabled by remember { mutableStateOf(notificationsEnabled(context)) }
    var dismissed by remember { mutableStateOf(prefs.getBoolean(DISMISSED, false)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { enabled = notificationsEnabled(context) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        enabled = granted || notificationsEnabled(context)
    }
    if (enabled || dismissed) return

    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    HomeHubCard(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            Icon(Icons.Outlined.NotificationsActive, null, tint = c.brand)
            Text("Get reminders on this phone", style = t.cardTitle, color = c.ink)
        }
        Text("HomeHub can tell you about bills due, overdue tasks, low stock and requests waiting for your approval. You choose which ones in Settings.",
            style = t.bodyCompact, color = c.inkSecondary)
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            HomeHubButton("Turn on", {
                val activity = context as? Activity
                val canAsk = Build.VERSION.SDK_INT >= 33 && (!prefs.getBoolean(ASKED, false) ||
                    (activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)))
                if (canAsk) {
                    prefs.edit().putBoolean(ASKED, true).apply()
                    launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            })
            HomeHubButton("Not now", { prefs.edit().putBoolean(DISMISSED, true).apply(); dismissed = true }, kind = ButtonKind.Tertiary)
        }
    }
}

fun notificationsEnabled(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
