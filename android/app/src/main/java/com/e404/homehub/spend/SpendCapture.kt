package com.e404.homehub.spend

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.e404.homehub.AppGraph
import com.e404.homehub.data.remote.GatewayException
import com.e404.homehub.data.repo.arr
import com.e404.homehub.data.repo.objects
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Automatic spending capture from payment notifications (UPI apps, bank apps, the SMS app showing
 * bank alerts). Off until the person turns it on in Settings and grants notification access.
 *
 * Privacy: only notifications from [PAYMENT_APPS] that look like a completed payment ([looksLikePayment])
 * leave the phone. Everything else is ignored on the device. The server parses, deduplicates and files
 * matches in a "To review" inbox; nothing is booked until someone confirms it.
 */
object SpendCapture {
    private const val PREFS = "homehub.spendCapture"

    /** Payment and banking apps whose notifications may carry a completed payment. */
    val PAYMENT_APPS = setOf(
        "com.google.android.apps.nbu.paisa.user", // Google Pay
        "com.phonepe.app", "net.one97.paytm", "in.org.npci.upiapp", // PhonePe, Paytm, BHIM
        "in.amazon.mShop.android.shopping", "com.dreamplug.androidapp", "com.mobikwik_new", // Amazon Pay, CRED, MobiKwik
        "com.csam.icici.bank.imobile", "com.snapwork.hdfc", "com.sbi.lotusintouch", "com.axis.mobile", "com.msf.kbank.mobile",
        "com.bankofbaroda.mconnect", "com.infrasofttech.indianBank", "com.fss.pnbpsp", "com.idfcfirstbank.optimus",
        // SMS apps (bank debit/credit alerts arrive as SMS).
        "com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms",
    )

    private val AMOUNT = Regex("""(₹|\bRs\.?|\bINR)\s*[0-9][0-9,]*(\.[0-9]{1,2})?""", RegexOption.IGNORE_CASE)
    // Keep this a superset-compatible match of the server parser (finance/spendCapture.ts DEBIT/CREDIT): anything the
    // server could file must be allowed to leave the phone, or bank SMS like "Txn of Rs 500 …" or "… Dr." never arrive.
    private val VERB = Regex(
        """\b(debited|credited|paid|spent|sent|received|withdrawn|purchase|txn of|transaction of|used for|refund(ed)?|cashback|deposited)\b|\b(dr|cr)\b\.?""",
        RegexOption.IGNORE_CASE,
    )
    private val NOT_PAYMENT = Regex(
        """\b(OTP|one[- ]time password|verification code|will be (debited|deducted|charged)|(is|are) due|has requested|requested (money|payment)|collect request|failed|declined|unsuccessful|not processed)\b""",
        RegexOption.IGNORE_CASE,
    )

    /** On-device filter: only completed-payment-looking text is ever sent. */
    fun looksLikePayment(text: String): Boolean =
        text.length in 8..1000 && AMOUNT.containsMatchIn(text) && VERB.containsMatchIn(text) && !NOT_PAYMENT.containsMatchIn(text)

    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun isEnabled(context: Context) = prefs(context).getBoolean("enabled", false)
    fun householdId(context: Context): String? = prefs(context).getString("hid", null)
    fun enable(context: Context, hid: String) = prefs(context).edit().putBoolean("enabled", true).putString("hid", hid).apply()
    fun disable(context: Context) = prefs(context).edit().putBoolean("enabled", false).apply()

    /** Whether the person has granted HomeHub notification access in system settings. */
    fun hasAccess(context: Context): Boolean {
        val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
        val me = ComponentName(context, SpendNotificationListener::class.java)
        return flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.any { it == me }
    }

    /** Remembers recent texts so a re-posted notification isn't sent twice (the server also deduplicates). */
    @Synchronized
    fun seenRecently(context: Context, text: String): Boolean {
        val h = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
        val p = prefs(context)
        val recent = p.getString("recent", "").orEmpty().split(',').filter { it.isNotBlank() }
        if (h in recent) return true
        p.edit().putString("recent", (recent.takeLast(49) + h).joinToString(",")).apply()
        return false
    }
}

class SpendNotificationListener : NotificationListenerService() {
    /** The system can drop the binding (app update, battery management); ask to be reconnected so capture doesn't silently stop. */
    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        if (SpendCapture.isEnabled(applicationContext) && SpendCapture.hasAccess(applicationContext)) {
            runCatching { requestRebind(ComponentName(applicationContext, SpendNotificationListener::class.java)) }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val ctx = applicationContext
        // Debug builds also accept `adb shell cmd notification post` (package com.android.shell) for end-to-end QA.
        val allowed = sbn.packageName in SpendCapture.PAYMENT_APPS || (com.e404.homehub.BuildConfig.DEBUG && sbn.packageName == "com.android.shell")
        if (!SpendCapture.isEnabled(ctx) || !allowed) return
        val hid = SpendCapture.householdId(ctx) ?: return
        val extras = sbn.notification.extras
        val text = listOfNotNull(
            extras.getCharSequence(Notification.EXTRA_TITLE),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT),
        ).joinToString(" ").trim()
        if (com.e404.homehub.BuildConfig.DEBUG) android.util.Log.d("HomeHubSpend", "pkg=${sbn.packageName} payment=${SpendCapture.looksLikePayment(text)} text=${text.take(80)}")
        if (!SpendCapture.looksLikePayment(text) || SpendCapture.seenRecently(ctx, text)) return
        SpendUploadWorker.enqueue(ctx, hid, text, Instant.ofEpochMilli(sbn.postTime).toString(), sbn.packageName)
    }
}

/** Sends one captured message to the gateway; survives being offline (WorkManager retries with backoff). */
class SpendUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = AppGraph.get(applicationContext)
        if (graph.auth.currentUser == null) return Result.success() // signed out: drop silently
        val hid = inputData.getString("hid") ?: return Result.failure()
        val body = buildJsonObject {
            put("source", "android_notification")
            put("text", inputData.getString("text").orEmpty())
            inputData.getString("receivedAt")?.let { put("receivedAt", it) }
            inputData.getString("sender")?.let { put("sender", it) }
        }
        return try {
            graph.gateway.call("POST", "/v1/households/$hid/spend/captures", body); Result.success()
        } catch (e: GatewayException) {
            if (e.code == "network" || e.status >= 500 || e.status == 429) Result.retry() else Result.failure()
        }
    }

    companion object {
        fun enqueue(context: Context, hid: String, text: String, receivedAt: String, sender: String) {
            val req = OneTimeWorkRequestBuilder<SpendUploadWorker>()
                .setInputData(workDataOf("hid" to hid, "text" to text, "receivedAt" to receivedAt, "sender" to sender))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueue(req)
        }
    }
}

/** Review inbox API (gateway). */
class SpendRepository(private val gateway: com.e404.homehub.data.remote.GatewayClient) {
    private fun h(hid: String) = "/v1/households/$hid/spend/captures"
    suspend fun pending(hid: String): List<JsonObject> = (gateway.call("GET", h(hid))?.jsonObject ?: JsonObject(emptyMap())).arr("items").objects()
    suspend fun confirm(hid: String, id: String, category: String) =
        gateway.call("POST", "${h(hid)}/$id/confirm", buildJsonObject { put("category", category) })
    suspend fun dismiss(hid: String, id: String) = gateway.call("POST", "${h(hid)}/$id/dismiss")
}
