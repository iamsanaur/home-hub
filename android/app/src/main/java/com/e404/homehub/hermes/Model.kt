package com.e404.homehub.hermes

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject

/** One OpenAI-style chat message. `toolCalls` on assistant turns, `toolCallId` on tool results. */
data class ChatMessage(
    val role: String,
    val content: String?,
    val toolCalls: List<ToolCall> = emptyList(),
    val toolCallId: String? = null,
)

data class ToolCall(val id: String, val name: String, val argumentsJson: String)

data class ToolSpec(val name: String, val description: String, val parameters: JsonObject, val readOnly: Boolean)

sealed interface ModelEvent {
    data class TextDelta(val text: String) : ModelEvent
    data class ToolCalls(val calls: List<ToolCall>) : ModelEvent
    data class Usage(val input: Int, val output: Int) : ModelEvent
}

class ModelUnavailable(message: String, val code: String = "agent_unavailable") : Exception(message)

/** The only thing Hermes Mobile needs from an LLM. Implementations: HomeHub model proxy (production), fakes (tests). */
interface ModelClient {
    fun complete(messages: List<ChatMessage>, tools: List<ToolSpec>, tier: String): Flow<ModelEvent>
}
