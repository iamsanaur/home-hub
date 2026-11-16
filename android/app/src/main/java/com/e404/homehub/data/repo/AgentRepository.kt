package com.e404.homehub.data.repo

import com.e404.homehub.data.model.AgentMessage
import com.e404.homehub.data.model.AgentSession
import com.e404.homehub.data.model.Approval
import com.e404.homehub.data.remote.GatewayClient
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

data class RunStart(val sessionId: String, val workflowId: String, val mode: String, val answer: JsonElement?)

/** HomeHub agent: runs go through the gateway; history and approvals are read from Firestore (owner-only per rules). */
class AgentRepository(private val db: FirebaseFirestore, private val gateway: GatewayClient) {

    suspend fun start(hid: String, message: String, sessionId: String?): RunStart {
        val body = buildJsonObject {
            put("message", message); put("idempotencyKey", UUID.randomUUID().toString())
            if (sessionId != null) put("sessionId", sessionId)
        }
        val o = gateway.call("POST", "/v1/households/$hid/agent/runs", body)!!.jsonObject
        return RunStart(o["sessionId"]!!.jsonPrimitive.content, o["workflowId"]!!.jsonPrimitive.content, o["mode"]!!.jsonPrimitive.content, o["answer"])
    }

    fun events(hid: String, workflowId: String): Flow<JsonObject> = gateway.events("/v1/households/$hid/agent/workflows/$workflowId/events")

    suspend fun stop(hid: String, workflowId: String) { gateway.call("POST", "/v1/households/$hid/agent/workflows/$workflowId/stop") }

    fun sessions(hid: String, uid: String): Flow<List<AgentSession>> = callbackFlow {
        val reg = db.collection("households/$hid/agentSessions").whereEqualTo("ownerUid", uid).orderBy("updatedAt", Query.Direction.DESCENDING).limit(30)
            .addSnapshotListener { s, _ -> trySend(s?.documents?.map(AgentSession::from).orEmpty()) }
        awaitClose { reg.remove() }
    }

    fun messages(hid: String, sessionId: String): Flow<List<AgentMessage>> = callbackFlow {
        val reg = db.collection("households/$hid/agentSessions/$sessionId/messages").orderBy("createdAt").limitToLast(100)
            .addSnapshotListener { s, _ -> trySend(s?.documents?.map(AgentMessage::from).orEmpty()) }
        awaitClose { reg.remove() }
    }

    fun pendingApprovals(hid: String): Flow<List<Approval>> = callbackFlow {
        val reg = db.collection("households/$hid/approvals").whereEqualTo("status", "pending").orderBy("createdAt", Query.Direction.DESCENDING).limit(30)
            .addSnapshotListener { s, _ -> trySend(s?.documents?.map(Approval::from)?.filter { a -> a.expiresAt == null || a.expiresAt.isAfter(java.time.Instant.now()) }.orEmpty()) }
        awaitClose { reg.remove() }
    }

    fun approval(hid: String, id: String): Flow<Approval?> = callbackFlow {
        val reg = db.document("households/$hid/approvals/$id").addSnapshotListener { s, _ -> trySend(s?.takeIf { it.exists() }?.let(Approval::from)) }
        awaitClose { reg.remove() }
    }

    suspend fun decide(hid: String, id: String, approve: Boolean, note: String?): JsonObject =
        gateway.call("POST", "/v1/households/$hid/approvals/$id/decision", buildJsonObject {
            put("decision", if (approve) "approve" else "reject"); if (!note.isNullOrBlank()) put("note", note)
        })!!.jsonObject

    suspend fun setAutonomy(hid: String, mode: String? = null, paused: Boolean? = null) {
        gateway.call("POST", "/v1/households/$hid/autonomy", buildJsonObject {
            if (mode != null) put("mode", mode); if (paused != null) put("paused", JsonPrimitive(paused))
        })
    }

    suspend fun usage(hid: String): JsonObject = gateway.call("GET", "/v1/households/$hid/agent/usage")!!.jsonObject
    suspend fun briefing(hid: String): JsonObject = gateway.call("GET", "/v1/households/$hid/briefing")!!.jsonObject
    suspend fun report(hid: String, kind: String): JsonObject = gateway.call("GET", "/v1/households/$hid/reports/$kind")!!.jsonObject
    suspend fun budget(hid: String, period: String): JsonObject = gateway.call("GET", "/v1/households/$hid/budget/$period")!!.jsonObject
    suspend fun health(): JsonObject = gateway.call("GET", "/v1/health")!!.jsonObject
    suspend fun jobAction(hid: String, jobId: String, action: String) { gateway.call("POST", "/v1/households/$hid/jobs/$jobId", buildJsonObject { put("action", action) }) }
    suspend fun mealShoppingList(hid: String, weekStart: String): JsonObject = gateway.call("POST", "/v1/households/$hid/meal-plans/$weekStart/shopping-list")!!.jsonObject
    suspend fun recordBillPayment(hid: String, billId: String, amountMinor: Long, currency: String, paidAtIso: String, method: String): JsonObject =
        gateway.call("POST", "/v1/households/$hid/bills/$billId/payments", buildJsonObject {
            put("amountMinor", amountMinor); put("currency", currency); put("paidAt", paidAtIso); put("method", method); put("idempotencyKey", "bill-$billId-${UUID.randomUUID()}")
        })!!.jsonObject
    suspend fun memories(hid: String): JsonObject = gateway.call("GET", "/v1/households/$hid/memories")!!.jsonObject
    suspend fun deleteMemory(hid: String, id: String) { gateway.call("DELETE", "/v1/households/$hid/memories/$id") }

    // ---- pay-per-delivery (vendor) bills ----
    suspend fun createVendorBill(hid: String, body: JsonObject): JsonObject = gateway.call("POST", "/v1/households/$hid/vendor-bills", body)!!.jsonObject
    suspend fun updateVendorBill(hid: String, billId: String, body: JsonObject): JsonObject = gateway.call("PATCH", "/v1/households/$hid/vendor-bills/$billId", body)!!.jsonObject
    suspend fun billLedger(hid: String, billId: String, month: String?): JsonObject =
        gateway.call("GET", "/v1/households/$hid/vendor-bills/$billId/ledger" + (month?.let { "?month=$it" } ?: ""))!!.jsonObject
    /** quantity: 0 = didn't come, a number = that quantity, null = back to the normal schedule. */
    suspend fun setDeliveries(hid: String, billId: String, entries: List<Pair<String, Double?>>): JsonObject =
        gateway.call("PUT", "/v1/households/$hid/vendor-bills/$billId/deliveries", buildJsonObject {
            put("entries", kotlinx.serialization.json.JsonArray(entries.map { (d, q) -> buildJsonObject { put("date", d); put("quantity", q?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull) } }))
        })!!.jsonObject
}
