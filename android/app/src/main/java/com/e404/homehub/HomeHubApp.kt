package com.e404.homehub

import android.app.Application
import androidx.work.Configuration
import androidx.work.WorkManager
import com.e404.homehub.data.sync.SyncWorker
import com.e404.homehub.notifications.Channels

class HomeHubApp : Application() {
    override fun onCreate() {
        super.onCreate()
        WorkManager.initialize(this, Configuration.Builder().setMinimumLoggingLevel(android.util.Log.INFO).build())
        AppGraph.get(this)
        Channels.create(this)
        // Flush anything queued while the app was closed.
        SyncWorker.schedule(this)
    }
}
