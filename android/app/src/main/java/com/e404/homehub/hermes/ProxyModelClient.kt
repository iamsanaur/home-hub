package com.e404.homehub.hermes

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Calls the HomeHub model proxy (POST …/agent/workflows/{wid}/model), which forwards to the
 * configured provider. The phone never holds a provider key and never picks the model —
 * it only sends a tier, which the server treats as a ceiling.
 */
class ProxyModelClient(
    private val url: String,
    private val authHeaders: suspend () -> Map<String, String>,
    private val http: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).build(),
) : ModelClient {

    override fun complete(messages: List<ChatMessage>, tools: List<ToolSpec>, tier: String): Flow<ModelEvent> = callbackFlow {
        val body = buildJsonObject {
            put("tier", tier)
            put("messages", encodeMessages(messages))
            if (tools.isNotEmpty()) put("tools", encodeTools(tools))
        }
        val req = Request.Builder().url(url).apply {
            authHeaders().forEach { (k, v) -> header(k, v) }
            header("Accept", "text/event-stream")
            post(body.toString().toRequestBody("application/json".toMediaType()))
        }.build()
        val call: Call = http.newCall(req)
        try {
            call.execute().use { res ->
                if (!res.isSuccessful) {
                    val err = runCatching { Json.parseToJsonElement(res.body.string()).jsonObject["error"]?.jsonObject }.getOrNull()
                    throw ModelUnavailable(err?.get("message")?.jsonPrimitive?.contentOrNull ?: "The assistant's model returned ${res.code}.",
                        err?.get("code")?.jsonPrimitive?.contentOrNull ?: "model_error")
                }
                val parser = ChunkAccumulator()
                val source = res.body.source()
                while (!source.exhausted()) {
                    val line = source.readUtf8Line() ?: break
                    if (!line.startsWith("data:")) continue
                    val data = line.removePrefix("data:").trim()
                    if (data == "[DONE]") break
                    parser.accept(data).forEach { trySend(it) }
                }
                parser.finish().forEach { trySend(it) }
            }
            close()
        } catch (e: ModelUnavailable) {
            close(e)
        } catch (e: Exception) {
            close(ModelUnavailable("Lost connection to the assistant's model."))
        }
        awaitClose { call.cancel() }
    }.flowOn(Dispatchers.IO)

    companion object {
        fun encodeMessages(messages: List<ChatMessage>): JsonArray = buildJsonArray {
            messages.forEach { m ->
                add(buildJsonObject {
                    put("role", m.role)
                    put("content", m.content?.let { JsonPrimitive(it) } ?: JsonNull)
                    if (m.toolCalls.isNotEmpty()) put("tool_calls", buildJsonArray {
                        m.toolCalls.forEach { c -> add(buildJsonObject {
                            put("id", c.id); put("type", "function")
                            put("function", buildJsonObject { put("name", c.name); put("arguments", c.argumentsJson) })
                        }) }
                    })
                    if (m.toolCallId != null) put("tool_call_id", m.toolCallId)
                })
            }
        }

        fun encodeTools(tools: List<ToolSpec>): JsonArray = buildJsonArray {
            tools.forEach { t -> add(buildJsonObject {
                put("type", "function")
                put("function", buildJsonObject { put("name", t.name); put("description", t.description); put("parameters", t.parameters) })
            }) }
        }
    }
}

/** Reassembles streamed OpenAI chat.completion.chunk frames (text deltas + fragmented tool calls). */
class ChunkAccumulator {
    private val ids = sortedMapOf<Int, String>()
    private val names = sortedMapOf<Int, String>()
    private val args = sortedMapOf<Int, StringBuilder>()

    fun accept(data: String): List<ModelEvent> {
        val o = runCatching { Json.parseToJsonElement(data).jsonObject }.getOrNull() ?: return emptyList()
        val out = mutableListOf<ModelEvent>()
        o["usage"]?.takeIf { it is JsonObject }?.jsonObject?.let { u ->
            out += ModelEvent.Usage(u["prompt_tokens"]?.jsonPrimitive?.intOrNull ?: 0, u["completion_tokens"]?.jsonPrimitive?.intOrNull ?: 0)
        }
        val delta = (o["choices"] as? JsonArray)?.firstOrNull()?.jsonObject?.get("delta") as? JsonObject ?: return out
        (delta["content"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }?.let { out += ModelEvent.TextDelta(it) }
        (delta["tool_calls"] as? JsonArray)?.forEach { el ->
            val tc = el.jsonObject
            val idx = tc["index"]?.jsonPrimitive?.intOrNull ?: 0
            tc["id"]?.jsonPrimitive?.contentOrNull?.let { ids[idx] = it }
            val fn = tc["function"] as? JsonObject
            fn?.get("name")?.jsonPrimitive?.contentOrNull?.let { names[idx] = (names[idx] ?: "") + it }
            fn?.get("arguments")?.jsonPrimitive?.contentOrNull?.let { args.getOrPut(idx) { StringBuilder() }.append(it) }
        }
        return out
    }

    fun finish(): List<ModelEvent> {
        if (names.isEmpty()) return emptyList()
        return listOf(ModelEvent.ToolCalls(names.map { (i, n) -> ToolCall(ids[i] ?: "call_$i", n, args[i]?.toString()?.ifBlank { "{}" } ?: "{}") }))
    }
}
