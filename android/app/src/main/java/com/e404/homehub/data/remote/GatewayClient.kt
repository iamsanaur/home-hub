package com.e404.homehub.data.remote

import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class GatewayException(val status: Int, val code: String, override val message: String) : Exception(message) {
    val isAgentUnavailable get() = code == "agent_unavailable"
}

/**
 * Client for the HomeHub API gateway (privileged operations + agent). Every request
 * carries a fresh Firebase ID token and, outside the emulator, an App Check token.
 * The Hermes runtime is never contacted directly.
 */
class GatewayClient(private val baseUrl: () -> String, private val useAppCheck: () -> Boolean) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // SSE streams stay open; per-call timeouts below
        .callTimeout(0, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonType = "application/json".toMediaType()

    private suspend fun headers(): Map<String, String> {
        val user = FirebaseAuth.getInstance().currentUser ?: throw GatewayException(401, "unauthenticated", "Sign in required")
        val token = user.getIdToken(false).await().token ?: throw GatewayException(401, "unauthenticated", "Sign in required")
        val h = mutableMapOf("Authorization" to "Bearer $token")
        if (useAppCheck()) runCatching { FirebaseAppCheck.getInstance().getAppCheckToken(false).await().token }.getOrNull()?.let { h["X-Firebase-AppCheck"] = it }
        return h
    }

    suspend fun call(method: String, path: String, body: JsonElement? = null): JsonElement? = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(baseUrl() + path).apply {
            headers().forEach { (k, v) -> header(k, v) }
            val rb = body?.toString()?.toRequestBody(jsonType) ?: if (method == "GET" || method == "DELETE") null else "{}".toRequestBody(jsonType)
            method(method, rb)
        }.build()
        val res = try {
            http.newBuilder().callTimeout(30, TimeUnit.SECONDS).build().newCall(req).execute()
        } catch (e: IOException) {
            throw GatewayException(0, "network", "You're offline or the server can't be reached. Try again.")
        }
        res.use {
            val text = it.body.string()
            if (!it.isSuccessful) {
                val err = runCatching { json.parseToJsonElement(text).jsonObject["error"]?.jsonObject }.getOrNull()
                throw GatewayException(it.code, err?.get("code")?.jsonPrimitive?.content ?: "http_${it.code}", err?.get("message")?.jsonPrimitive?.content ?: "Something went wrong (${it.code}).")
            }
            if (text.isBlank()) null else json.parseToJsonElement(text)
        }
    }

    /** Server-sent events from the agent workflow stream. Cancelling the flow closes the connection. */
    fun events(path: String): Flow<JsonObject> = callbackFlow {
        val req = Request.Builder().url(baseUrl() + path).apply {
            headers().forEach { (k, v) -> header(k, v) }
            header("Accept", "text/event-stream")
        }.build()
        val call: Call = http.newCall(req)
        try {
            call.execute().use { res ->
                if (!res.isSuccessful) throw GatewayException(res.code, "stream_failed", "Couldn't connect to the assistant (${res.code}).")
                val source = res.body.source()
                val buf = StringBuilder()
                while (!source.exhausted()) {
                    val line = source.readUtf8Line() ?: break
                    if (line.isEmpty()) {
                        val data = buf.toString(); buf.clear()
                        if (data.isNotBlank()) runCatching { json.parseToJsonElement(data).jsonObject }.getOrNull()?.let { trySend(it) }
                    } else if (line.startsWith("data:")) buf.append(line.removePrefix("data:").trimStart())
                }
            }
            close()
        } catch (e: Exception) {
            close(if (e is GatewayException) e else GatewayException(0, "network", "The connection to the assistant dropped."))
        }
        awaitClose { call.cancel() }
    }.flowOn(Dispatchers.IO)
}
