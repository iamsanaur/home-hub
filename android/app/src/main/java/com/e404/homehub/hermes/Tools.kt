package com.e404.homehub.hermes

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Where household tools live. Production: the HomeHub MCP server. Tests: a fake. */
interface ToolHost {
    suspend fun listTools(): List<ToolSpec>
    /** Returns the tool's text result (compact JSON from HomeHub). Never throws for tool-level errors. */
    suspend fun call(name: String, argumentsJson: String): String
}

/**
 * Minimal MCP client over Streamable HTTP (JSON responses). Auth = the user's Firebase ID
 * token; the server additionally requires the per-run grant inside each call's arguments.
 */
class McpToolHost(
    private val url: String,
    private val authHeaders: suspend () -> Map<String, String>,
    private val http: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build(),
) : ToolHost {
    private val ids = AtomicInteger(1)
    private var cached: List<ToolSpec>? = null

    private suspend fun rpc(method: String, params: JsonObject): JsonObject = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("jsonrpc", "2.0"); put("id", ids.getAndIncrement()); put("method", method); put("params", params) }
        val req = Request.Builder().url(url).apply {
            authHeaders().forEach { (k, v) -> header(k, v) }
            header("Accept", "application/json, text/event-stream")
            post(body.toString().toRequestBody("application/json".toMediaType()))
        }.build()
        http.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ModelUnavailable("Household tools unavailable (${res.code}).", "tools_unavailable")
            // Streamable HTTP may answer as JSON or as a single SSE frame.
            val json = if (text.trimStart().startsWith("{")) text else text.lineSequence().filter { it.startsWith("data:") }.joinToString("") { it.removePrefix("data:").trim() }
            val o = Json.parseToJsonElement(json).jsonObject
            o["error"]?.let { throw ModelUnavailable(it.jsonObject["message"]?.jsonPrimitive?.contentOrNull ?: "Tool error", "tools_error") }
            o["result"]!!.jsonObject
        }
    }

    override suspend fun listTools(): List<ToolSpec> = cached ?: rpc("tools/list", JsonObject(emptyMap()))["tools"]!!.jsonArray.map { t ->
        val o = t.jsonObject
        ToolSpec(
            o["name"]!!.jsonPrimitive.content,
            o["description"]?.jsonPrimitive?.contentOrNull ?: "",
            stripGrant(o["inputSchema"]!!.jsonObject),
            (o["annotations"] as? JsonObject)?.get("readOnlyHint")?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }.also { cached = it }

    override suspend fun call(name: String, argumentsJson: String): String = try {
        val args = runCatching { Json.parseToJsonElement(argumentsJson).jsonObject }.getOrElse { JsonObject(emptyMap()) }
        val r = rpc("tools/call", buildJsonObject { put("name", name); put("arguments", args) })
        (r["content"] as? JsonArray)?.firstOrNull()?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull ?: r.toString()
    } catch (e: ModelUnavailable) {
        """{"ok":false,"error":{"code":"${e.code}","message":"${e.message?.replace("\"", "'")}"}}"""
    }

    companion object {
        /** The grant is injected by the runtime, never chosen by the model: hide it from the schema. */
        fun stripGrant(schema: JsonObject): JsonObject {
            val props = (schema["properties"] as? JsonObject)?.filterKeys { it != "grant" } ?: emptyMap()
            val required = (schema["required"] as? JsonArray)?.filter { it.jsonPrimitive.content != "grant" }
            return JsonObject(schema + mapOf("properties" to JsonObject(props)) + (required?.let { mapOf("required" to JsonArray(it)) } ?: emptyMap()))
        }
    }
}

/** Hermes' own tools, implemented natively. */
object BuiltinTools {
    const val SKILL_VIEW = "skill_view"
    const val TODO = "todo"
    const val DELEGATE = "delegate_task"

    private fun schema(props: Map<String, String>, required: List<String>) = buildJsonObject {
        put("type", "object")
        putJsonObject("properties") { props.forEach { (k, d) -> putJsonObject(k) { put("type", "string"); put("description", d) } } }
        put("required", JsonArray(required.map { JsonPrimitive(it) }))
    }

    fun specs(allowDelegation: Boolean): List<ToolSpec> = buildList {
        add(ToolSpec(SKILL_VIEW, "Load the full procedure of a skill by name before acting.", schema(mapOf("name" to "Skill name"), listOf("name")), true))
        add(ToolSpec(TODO, "Record a short plan (newline-separated steps) for multi-step work.", schema(mapOf("plan" to "Steps, one per line"), listOf("plan")), true))
        if (allowDelegation) add(ToolSpec(DELEGATE, "Hand ONE large, self-contained sub-task to a focused helper with its own short context. Use rarely.",
            schema(mapOf("task" to "What the helper must do", "skill" to "Skill the helper should load"), listOf("task")), false))
    }

    fun isBuiltin(name: String) = name == SKILL_VIEW || name == TODO || name == DELEGATE
}

internal fun jsonStr(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
