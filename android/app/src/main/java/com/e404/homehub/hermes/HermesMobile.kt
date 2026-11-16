package com.e404.homehub.hermes

import android.content.Context
import com.e404.homehub.data.remote.FirebaseBootstrap
import com.e404.homehub.data.remote.GatewayClient
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** What the person sees at the end of a run — taken from the SERVER's verification, not the model's text. */
data class RunOutcome(
    val workflowId: String?,
    val sessionId: String?,
    val state: String, // completed | awaiting_approval | partially_completed | failed | cancelled | deterministic
    val text: String,
    val verifiedActions: List<String>,
    val approvalIds: List<String>,
    val deterministicAnswer: JsonElement? = null,
    val error: String? = null,
)

/**
 * Hermes Mobile: the HomeHub agent runtime running on this phone.
 *  1. ask the gateway for a run ticket (routing, context, grant, budgets — battery-aware);
 *  2. run the agent loop here (model calls via the HomeHub proxy, tools via HomeHub MCP);
 *  3. report completion; the server verifies what actually happened from its audit log.
 */
class HermesMobile(
    private val context: Context,
    private val gateway: GatewayClient,
    private val skills: SkillRegistry,
    val power: PowerSource = AndroidPower(context),
) {
    private suspend fun authHeaders(): Map<String, String> {
        val token = FirebaseAuth.getInstance().currentUser?.getIdToken(false)?.await()?.token ?: throw ModelUnavailable("Sign in required", "unauthenticated")
        return mapOf("Authorization" to "Bearer $token")
    }

    private fun mcpUrl(): String = FirebaseBootstrap.gatewayBaseUrl().replace(Regex("/api$"), "/mcp")

    suspend fun run(hid: String, message: String, sessionId: String?, history: List<ChatMessage>, emit: (AgentEvent) -> Unit): RunOutcome {
        val snap = power.snapshot()
        if (!snap.allowsForegroundAgent) {
            return RunOutcome(null, sessionId, "cancelled", "", emptyList(), emptyList(), error = "Your phone is critically low on battery or too warm. Try again once it's charging or cooler.")
        }
        val powerTag = when (snap.mode) { PowerMode.Normal -> "normal"; PowerMode.Saver -> "saver"; PowerMode.Critical -> "critical" }
        val start = gateway.call("POST", "/v1/households/$hid/agent/device-runs", buildJsonObject {
            put("message", message); put("power", powerTag); sessionId?.let { put("sessionId", it) }
        })!!.jsonObject
        val sid = start["sessionId"]!!.jsonPrimitive.content
        val wid = start["workflowId"]!!.jsonPrimitive.content
        if (start["mode"]!!.jsonPrimitive.content == "deterministic") {
            return RunOutcome(wid, sid, "deterministic", "", emptyList(), emptyList(), deterministicAnswer = start["answer"])
        }
        val limits = start["limits"]!!.jsonObject
        val ticket = RunTicket(
            wid, sid, start["instructions"]!!.jsonPrimitive.content, start["grant"]!!.jsonPrimitive.content,
            start["tier"]!!.jsonPrimitive.content, start["skill"]!!.jsonPrimitive.content,
            RunLimits(limits["maxIterations"]!!.jsonPrimitive.intOrNull ?: 8, limits["maxToolCalls"]!!.jsonPrimitive.intOrNull ?: 30, limits["toolOutputChars"]!!.jsonPrimitive.intOrNull ?: 4000),
        )
        if (snap.mode == PowerMode.Saver) emit(AgentEvent.Note("Battery saver: using a lighter plan."))
        val base = FirebaseBootstrap.gatewayBaseUrl()
        val loop = AgentLoop(
            ProxyModelClient("$base/v1/households/$hid/agent/workflows/$wid/model", ::authHeaders),
            McpToolHost(mcpUrl(), ::authHeaders),
            skills, power,
        )
        val result = try {
            loop.run(ticket, history, message, emit)
        } catch (e: kotlinx.coroutines.CancellationException) {
            runCatching { complete(hid, wid, "cancelled", "", 0, "Stopped by you") }
            throw e
        }
        val done = complete(hid, wid, result.status, result.output, result.toolCalls, result.error)
        return RunOutcome(
            wid, sid, done["state"]?.jsonPrimitive?.contentOrNull ?: result.status, result.output,
            done["verified"]?.jsonArray?.mapNotNull { (it as? JsonObject)?.get("action")?.jsonPrimitive?.contentOrNull }.orEmpty(),
            done["approvals"]?.jsonArray?.mapNotNull { (it as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull }.orEmpty(),
            error = result.error,
        )
    }

    private suspend fun complete(hid: String, wid: String, status: String, output: String, toolCalls: Int, error: String?): JsonObject =
        gateway.call("POST", "/v1/households/$hid/agent/workflows/$wid/complete", buildJsonObject {
            put("status", if (status in setOf("completed", "failed", "cancelled")) status else "failed")
            put("output", output.take(20000)); put("toolCalls", toolCalls); error?.let { put("error", it.take(500)) }
        })?.jsonObject ?: JsonObject(mapOf("state" to JsonPrimitive(status)))

    companion object {
        fun loadSkills(context: Context): SkillRegistry {
            val am = context.assets
            val names = runCatching { am.list("hermes/skills")?.toList() }.getOrNull().orEmpty()
            return SkillRegistry.fromTexts(names.mapNotNull { n -> runCatching { am.open("hermes/skills/$n/SKILL.md").bufferedReader().readText() }.getOrNull() })
        }
    }
}
