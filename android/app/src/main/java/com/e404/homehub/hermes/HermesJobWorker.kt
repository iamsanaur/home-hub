package com.e404.homehub.hermes

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.e404.homehub.AppGraph
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.TimeUnit

/**
 * Scheduled agent work (e.g. weekly meal planning) runs on the phone ONLY while it is
 * charging, idle and on an unmetered network. WorkManager batches it with other deferred work,
 * so the radio and CPU wake once. If the phone never qualifies, the server Hermes takes the
 * job after a grace period — a slot is claimed exactly once, so it never runs twice.
 */
class HermesJobWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = AppGraph.get(applicationContext)
        val hid = inputData.getString(KEY_HID) ?: return Result.success()
        if (graph.auth.currentUser == null) return Result.success()
        if (!graph.hermes.power.snapshot().allowsBackgroundAgent) return Result.success() // try at the next window; server is the fallback
        return try {
            val claim = graph.gateway.call("POST", "/v1/households/$hid/jobs/weekly_meal_planning/device-claim")!!.jsonObject
            if (claim["claimed"]?.jsonPrimitive?.booleanOrNull != true) return Result.success()
            val message = claim["message"]?.jsonPrimitive?.contentOrNull ?: return Result.success()
            graph.hermes.run(hid, message, null, emptyList()) { }
            Result.success()
        } catch (e: Exception) {
            Result.success() // never retry-loop in the background; the server fallback covers missed slots
        }
    }

    companion object {
        const val KEY_HID = "hid"
        fun schedule(context: Context, hid: String) {
            val req = PeriodicWorkRequestBuilder<HermesJobWorker>(12, TimeUnit.HOURS, 4, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiresCharging(true).setRequiresDeviceIdle(true).setRequiredNetworkType(NetworkType.UNMETERED).setRequiresBatteryNotLow(true).build())
                .setInputData(workDataOf(KEY_HID to hid))
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("hermes-jobs-$hid", ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
