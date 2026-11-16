package com.e404.homehub.data.sync

import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.util.Date

/** Serialises outbox field maps to JSON while keeping Firestore types (timestamps, server time, integers). */
object FieldCodec {
    private const val TS = "__ts"
    private const val SERVER_TIME = "__serverTime"

    /** Marker for "use the server's clock" in an outbox payload. */
    val ServerTime: Any = SERVER_TIME

    fun encode(fields: Map<String, Any?>): String = JsonObject(fields.mapValues { toJson(it.value) }).toString()

    fun decode(json: String): Map<String, Any?> = (Json.parseToJsonElement(json) as JsonObject).mapValues { fromJson(it.value) }

    private fun toJson(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        SERVER_TIME -> JsonObject(mapOf(SERVER_TIME to JsonPrimitive(true)))
        is Timestamp -> JsonObject(mapOf(TS to JsonPrimitive(v.toDate().time)))
        is Date -> JsonObject(mapOf(TS to JsonPrimitive(v.time)))
        is Boolean -> JsonPrimitive(v)
        is Int, is Long -> JsonPrimitive((v as Number).toLong())
        is Number -> JsonPrimitive(v.toDouble())
        is String -> JsonPrimitive(v)
        is List<*> -> JsonArray(v.map { toJson(it) })
        is Map<*, *> -> JsonObject(v.entries.associate { it.key.toString() to toJson(it.value) })
        else -> JsonPrimitive(v.toString())
    }

    private fun fromJson(e: JsonElement): Any? = when (e) {
        is JsonNull -> null
        is JsonObject -> when {
            e.containsKey(SERVER_TIME) -> FieldValue.serverTimestamp()
            e.containsKey(TS) -> Timestamp(Date((e[TS] as JsonPrimitive).longOrNull ?: 0))
            else -> e.mapValues { fromJson(it.value) }
        }
        is JsonArray -> e.map { fromJson(it) }
        is JsonPrimitive -> when {
            e.isString -> e.contentOrNull
            e.booleanOrNull != null -> e.booleanOrNull
            e.longOrNull != null -> e.longOrNull
            else -> e.doubleOrNull
        }
    }
}
