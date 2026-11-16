package com.e404.homehub.data.repo

import com.e404.homehub.data.remote.GatewayClient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder

/**
 * Gateway control plane (addendum Phase 1): integrations, model accounts, devices,
 * automations, channels, agents & skills, status, privacy and audit. Every call goes
 * through the HomeHub gateway, which applies policy, approvals and audit server-side.
 */
class ConnectRepository(private val gateway: GatewayClient) {
    private suspend fun get(path: String): JsonObject = gateway.call("GET", path)?.jsonObject ?: JsonObject(emptyMap())
    private suspend fun send(method: String, path: String, body: JsonElement? = null): JsonObject? = gateway.call(method, path, body)?.let { it as? JsonObject }
    private fun h(hid: String) = "/v1/households/$hid"

    suspend fun status(hid: String) = get("${h(hid)}/gateway/status")
    suspend fun catalog(): JsonArray = get("/v1/catalog").arr("items")
    suspend fun integrations(hid: String): JsonArray = get("${h(hid)}/integrations").arr("items")
    suspend fun connect(hid: String, pluginId: String, config: Map<String, String>, secrets: Map<String, String>, scope: String? = null) =
        send("POST", "${h(hid)}/integrations", buildJsonObject {
            put("pluginId", pluginId); put("consent", true)
            if (scope != null) put("scope", scope)
            if (config.isNotEmpty()) put("config", JsonObject(config.mapValues { JsonPrimitive(it.value) }))
            if (secrets.isNotEmpty()) put("secrets", JsonObject(secrets.mapValues { JsonPrimitive(it.value) }))
        })
    suspend fun test(hid: String, iid: String) = send("POST", "${h(hid)}/integrations/$iid/test")
    suspend fun pause(hid: String, iid: String, paused: Boolean) = send("POST", "${h(hid)}/integrations/$iid/pause", buildJsonObject { put("paused", paused) })
    suspend fun disconnect(hid: String, iid: String, deleteData: Boolean) = send("DELETE", "${h(hid)}/integrations/$iid?deleteData=$deleteData")
    suspend fun makeDefault(hid: String, iid: String) = send("PATCH", "${h(hid)}/integrations/$iid", buildJsonObject { put("isDefault", true) })

    suspend fun modelAccounts(hid: String) = get("${h(hid)}/model-accounts")
    suspend fun startOpenRouter(hid: String, scope: String): String =
        send("POST", "${h(hid)}/model-accounts/openrouter/start", buildJsonObject { put("scope", scope) })!!.str("authUrl")!!

    suspend fun devices(hid: String) = get("${h(hid)}/devices")
    suspend fun deviceAction(hid: String, did: String, action: JsonObject, confirmed: Boolean = false) =
        send("POST", "${h(hid)}/devices/$did/actions", buildJsonObject { put("action", action); if (confirmed) put("confirmed", true) })!!
    suspend fun exposeDevice(hid: String, did: String, exposed: Boolean) = send("PATCH", "${h(hid)}/devices/$did", buildJsonObject { put("alexaExposed", exposed) })
    suspend fun exposeRoom(hid: String, rid: String, exposed: Boolean) = send("PATCH", "${h(hid)}/rooms/$rid", buildJsonObject { put("alexaExposed", exposed) })

    suspend fun automations(hid: String): JsonArray = get("${h(hid)}/automations").arr("items")
    suspend fun saveAutomation(hid: String, body: JsonObject, id: String? = null) =
        if (id == null) send("POST", "${h(hid)}/automations", body) else send("PUT", "${h(hid)}/automations/$id", body)
    suspend fun deleteAutomation(hid: String, id: String) = send("DELETE", "${h(hid)}/automations/$id")
    suspend fun testAutomation(hid: String, id: String, execute: Boolean) = send("POST", "${h(hid)}/automations/$id/test", buildJsonObject { put("execute", execute) })!!
    suspend fun automationRuns(hid: String, id: String): JsonArray = get("${h(hid)}/automations/$id/runs").arr("items")

    suspend fun channels(hid: String): JsonArray = get("${h(hid)}/channels").arr("items")
    suspend fun disconnectAlexa(hid: String) = send("DELETE", "${h(hid)}/channels/alexa")
    suspend fun agents(hid: String) = get("${h(hid)}/agents")
    suspend fun setSkill(hid: String, name: String, enabled: Boolean) = send("PATCH", "${h(hid)}/skills/$name", buildJsonObject { put("enabled", enabled) })
    suspend fun privacy(hid: String) = get("${h(hid)}/privacy")
    suspend fun audit(hid: String, channel: String?, before: String?): JsonArray {
        val q = listOfNotNull(channel?.let { "channel=$it" }, before?.let { "before=${URLEncoder.encode(it, "UTF-8")}" }).joinToString("&")
        return get("${h(hid)}/audit-events${if (q.isEmpty()) "" else "?$q"}").arr("items")
    }
}

// ---- small JSON helpers shared by the connection screens ----
fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull
fun JsonObject.bool(k: String): Boolean = (this[k] as? JsonPrimitive)?.booleanOrNull ?: false
fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
fun JsonObject.obj(k: String): JsonObject = (this[k] as? JsonObject) ?: JsonObject(emptyMap())
fun JsonObject.arr(k: String): JsonArray = (this[k] as? JsonArray) ?: JsonArray(emptyList())
val JsonElement.o: JsonObject get() = this.jsonObject
fun JsonArray.objects(): List<JsonObject> = mapNotNull { it as? JsonObject }
fun JsonObject.strList(k: String): List<String> = (this[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
