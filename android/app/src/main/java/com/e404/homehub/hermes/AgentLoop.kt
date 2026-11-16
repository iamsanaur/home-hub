package com.e404.homehub.hermes

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.coroutines.coroutineContext

/** Server-issued run parameters (from POST …/agent/device-runs). */
data class RunLimits(val maxIterations: Int, val maxToolCalls: Int, val toolOutputChars: Int)
data class RunTicket(val workflowId: String, val sessionId: String, val instructions: String, val grant: String, val tier: String, val skill: String, val limits: RunLimits)

sealed interface AgentEvent {
    data class Delta(val text: String) : AgentEvent
    data class ToolStarted(val name: String) : AgentEvent
    data class ToolFinished(val name: String, val ok: Boolean) : AgentEvent
    data class Note(val text: String) : AgentEvent
}

data class LoopResult(val status: String, val output: String, val toolCalls: Int, val iterations: Int, val inputTokens: Int, val outputTokens: Int, val error: String? = null)

/**
 * Hermes Mobile agent loop — a native port of Hermes' conversation loop concepts:
 * one orchestrator, progressive skill loading, bounded iterations and tool calls,
 * tool-output filtering, context compaction without extra LLM calls, and rare
 * delegation to a focused sub-agent with its own small context.
 */
class AgentLoop(
    private val model: ModelClient,
    private val tools: ToolHost,
    private val skills: SkillRegistry,
    private val power: PowerSource,
    private val maxContextChars: Int = 24_000,
) {
    suspend fun run(ticket: RunTicket, history: List<ChatMessage>, userMessage: String, emit: (AgentEvent) -> Unit): LoopResult {
        val remote = runCatching { tools.listTools() }.getOrElse { return LoopResult("failed", "", 0, 0, 0, 0, it.message) }
        val readOnly = remote.filter { it.readOnly }.map { it.name }.toSet() + setOf(BuiltinTools.SKILL_VIEW, BuiltinTools.TODO)
        val toolSpecs = BuiltinTools.specs(allowDelegation = ticket.limits.maxIterations >= 10) + remote
        val messages = mutableListOf(
            ChatMessage("system", systemPrompt(ticket)),
        )
        messages += compactHistory(history)
        messages += ChatMessage("user", userMessage)
        return loop(ticket, messages, toolSpecs, readOnly, ticket.limits.maxIterations, ticket.tier, emit, depth = 0)
    }

    private fun systemPrompt(t: RunTicket) = buildString {
        append(t.instructions)
        append("\n\nAvailable skills (load with skill_view before following one):\n")
        append(skills.index())
        append("\n\nYou are running on the user's phone. Be economical: batch independent reads in one turn, avoid unnecessary calls, and stop as soon as the goal is met.")
    }

    private suspend fun loop(
        t: RunTicket, messages: MutableList<ChatMessage>, specs: List<ToolSpec>, readOnly: Set<String>,
        maxIterations: Int, tier: String, emit: (AgentEvent) -> Unit, depth: Int,
    ): LoopResult {
        var toolCalls = 0; var inTok = 0; var outTok = 0; var iterations = 0
        val output = StringBuilder()
        while (iterations < maxIterations) {
            coroutineContext.ensureActive()
            if (!power.snapshot().allowsForegroundAgent) {
                return LoopResult("cancelled", output.toString(), toolCalls, iterations, inTok, outTok, "Stopped to protect the battery (critically low or overheating).")
            }
            iterations++
            compactInPlace(messages)
            val text = StringBuilder()
            var calls: List<ToolCall> = emptyList()
            try {
                model.complete(messages, specs, tier).collect { e ->
                    when (e) {
                        is ModelEvent.TextDelta -> { text.append(e.text); if (depth == 0) emit(AgentEvent.Delta(e.text)) }
                        is ModelEvent.ToolCalls -> calls = e.calls
                        is ModelEvent.Usage -> { inTok += e.input; outTok += e.output }
                    }
                }
            } catch (e: ModelUnavailable) {
                return LoopResult(if (toolCalls > 0) "failed" else "failed", output.append(text).toString(), toolCalls, iterations, inTok, outTok, e.message)
            }
            if (calls.isEmpty()) {
                output.append(text)
                return LoopResult("completed", output.toString().trim(), toolCalls, iterations, inTok, outTok)
            }
            messages += ChatMessage("assistant", text.toString().ifBlank { null }, calls)
            if (toolCalls + calls.size > t.limits.maxToolCalls) {
                calls.forEach { messages += ChatMessage("tool", """{"ok":false,"error":{"code":"tool_budget_exceeded","message":"Stop and summarise."}}""", toolCallId = it.id) }
                continue
            }
            toolCalls += calls.size
            // Independent read-only calls run concurrently: fewer, shorter radio bursts.
            val results: List<Pair<ToolCall, String>> = if (calls.all { it.name in readOnly } && calls.size > 1) coroutineScope {
                calls.map { c -> async { c to exec(t, c, specs, readOnly, emit, depth) } }.awaitAll()
            } else calls.map { c -> c to exec(t, c, specs, readOnly, emit, depth) }
            results.forEach { (c, r) -> messages += ChatMessage("tool", truncate(r, t.limits.toolOutputChars), toolCallId = c.id) }
        }
        // Out of iterations: one last turn without tools so the person still gets a summary.
        val summary = StringBuilder()
        runCatching {
            messages += ChatMessage("user", "Iteration budget reached. Summarise what was done (verified) and what remains, without calling tools.")
            model.complete(messages, emptyList(), "simple").collect { e -> if (e is ModelEvent.TextDelta) { summary.append(e.text); if (depth == 0) emit(AgentEvent.Delta(e.text)) } else if (e is ModelEvent.Usage) { inTok += e.input; outTok += e.output } }
        }
        return LoopResult("completed", summary.toString().trim(), toolCalls, iterations, inTok, outTok)
    }

    private suspend fun exec(t: RunTicket, c: ToolCall, specs: List<ToolSpec>, readOnly: Set<String>, emit: (AgentEvent) -> Unit, depth: Int): String {
        if (depth == 0) emit(AgentEvent.ToolStarted(c.name))
        val args = runCatching { Json.parseToJsonElement(c.argumentsJson).jsonObject }.getOrElse { JsonObject(emptyMap()) }
        val result = when (c.name) {
            BuiltinTools.SKILL_VIEW -> skills.view(jsonStr(args, "name") ?: "")?.let { """{"ok":true,"skill":${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(it))}}""" }
                ?: """{"ok":false,"error":{"code":"unknown_skill","message":"Known skills: ${skills.names.joinToString()}"}}"""
            BuiltinTools.TODO -> """{"ok":true,"saved":true}"""
            BuiltinTools.DELEGATE -> if (depth > 0) """{"ok":false,"error":{"code":"no_nested_delegation","message":"Helpers cannot delegate."}}""" else delegate(t, args, specs, readOnly, emit)
            else -> {
                // The grant is injected here — the model never sees or chooses it.
                val withGrant = JsonObject(args + ("grant" to kotlinx.serialization.json.JsonPrimitive(t.grant)))
                tools.call(c.name, withGrant.toString())
            }
        }
        val ok = !result.contains("\"ok\":false") || result.contains("approval_required")
        if (depth == 0) emit(AgentEvent.ToolFinished(c.name, ok))
        return result
    }

    /** Focused helper: own short context, no further delegation, economical tier, 4 turns max. */
    private suspend fun delegate(t: RunTicket, args: JsonObject, specs: List<ToolSpec>, readOnly: Set<String>, emit: (AgentEvent) -> Unit): String {
        val task = jsonStr(args, "task") ?: return """{"ok":false,"error":{"code":"invalid_argument","message":"task is required"}}"""
        emit(AgentEvent.Note("Delegating: ${task.take(80)}"))
        val skill = jsonStr(args, "skill")?.let { skills.view(it) }
        val sub = mutableListOf(
            ChatMessage("system", "You are a focused HomeHub helper. Complete only this sub-task with the tools, then reply with a short factual result.\n" +
                // Same rules and context, minus the grant line (the runtime injects the grant itself).
                t.instructions.lineSequence().filterNot { it.startsWith("hhg_") }.joinToString("\n").take(3000) +
                (skill?.let { "\n\nSkill:\n$it" } ?: "")),
            ChatMessage("user", task),
        )
        val r = loop(t, sub, specs.filter { it.name != BuiltinTools.DELEGATE }, readOnly, 4, "simple", emit, depth = 1)
        return buildJsonObject { put("ok", r.status == "completed"); put("result", r.output.take(1500)); put("toolCalls", r.toolCalls) }.toString()
    }

    /** Older history is summarised structurally (no extra model call): keep the last turns verbatim. */
    private fun compactHistory(history: List<ChatMessage>): List<ChatMessage> {
        val recent = history.takeLast(6).filter { it.role == "user" || (it.role == "assistant" && it.toolCalls.isEmpty()) }
        return recent.map { it.copy(content = it.content?.take(1200)) }
    }

    /** Hermes-style tool-output compression: once the context is large, older tool results shrink to stubs. */
    internal fun compactInPlace(messages: MutableList<ChatMessage>) {
        var total = messages.sumOf { it.content?.length ?: 0 }
        if (total <= maxContextChars) return
        for (i in messages.indices) {
            if (total <= maxContextChars) break
            val m = messages[i]
            if (m.role == "tool" && (m.content?.length ?: 0) > 300 && i < messages.size - 4) {
                val before = m.content!!.length
                messages[i] = m.copy(content = m.content.take(240) + "…[older result compacted: ${before - 240} chars removed]")
                total -= before - messages[i].content!!.length
            }
        }
    }

    companion object {
        fun truncate(s: String, max: Int) = if (s.length <= max) s else s.take(max) + "…[truncated ${s.length - max} chars; ask for a narrower query]"
    }
}
