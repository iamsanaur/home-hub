package com.e404.homehub

import com.e404.homehub.hermes.AgentEvent
import com.e404.homehub.hermes.AgentLoop
import com.e404.homehub.hermes.ChatMessage
import com.e404.homehub.hermes.ChunkAccumulator
import com.e404.homehub.hermes.ModelClient
import com.e404.homehub.hermes.ModelEvent
import com.e404.homehub.hermes.ModelUnavailable
import com.e404.homehub.hermes.OfflineIntent
import com.e404.homehub.hermes.OfflineIntents
import com.e404.homehub.hermes.PowerMode
import com.e404.homehub.hermes.PowerSnapshot
import com.e404.homehub.hermes.RunLimits
import com.e404.homehub.hermes.RunTicket
import com.e404.homehub.hermes.SkillRegistry
import com.e404.homehub.hermes.ToolCall
import com.e404.homehub.hermes.ToolHost
import com.e404.homehub.hermes.ToolSpec
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private val SKILL = """
---
name: household-manager
description: Coordinates everyday household work.
version: 1.0.0
---

# Household manager
## Procedure
1. list_tasks
""".trimIndent()

/** Scripted model: each call returns the next step. Records what it was sent. */
private class FakeModel(private val steps: List<List<ModelEvent>>) : ModelClient {
    val sent = mutableListOf<List<ChatMessage>>()
    val tiers = mutableListOf<String>()
    override fun complete(messages: List<ChatMessage>, tools: List<ToolSpec>, tier: String): Flow<ModelEvent> = flow {
        sent += messages.toList(); tiers += tier
        steps.getOrElse(sent.size - 1) { steps.last() }.forEach { emit(it) }
    }
}

private class FakeTools(private val delayMs: Long = 0) : ToolHost {
    val calls = mutableListOf<Pair<String, String>>()
    val inFlight = AtomicInteger(0); var maxConcurrent = 0
    override suspend fun listTools() = listOf(
        ToolSpec("list_tasks", "List tasks", JsonObject(emptyMap()), readOnly = true),
        ToolSpec("get_low_stock_items", "Low stock", JsonObject(emptyMap()), readOnly = true),
        ToolSpec("create_task", "Create", JsonObject(emptyMap()), readOnly = false),
    )
    override suspend fun call(name: String, argumentsJson: String): String {
        val n = inFlight.incrementAndGet(); maxConcurrent = maxOf(maxConcurrent, n)
        if (delayMs > 0) delay(delayMs)
        inFlight.decrementAndGet()
        synchronized(calls) { calls += name to argumentsJson }
        return if (name == "create_task") """{"ok":true,"data":{"id":"t1"}}""" else """{"ok":true,"data":[${"\"x\",".repeat(3000)}"x"]}"""
    }
}

private fun power(mode: PowerMode = PowerMode.Normal) = com.e404.homehub.hermes.PowerSource {
    when (mode) {
        PowerMode.Normal -> PowerSnapshot(80, false, false, 0, true)
        PowerMode.Saver -> PowerSnapshot(15, false, true, 0, false)
        PowerMode.Critical -> PowerSnapshot(3, false, true, 0, false)
    }
}

private val TICKET = RunTicket("wf1", "s1", "You are homehub-hermes.\nContext: {}", "hhg_secret_grant_value_0000000000000000000000000000", "complex", "household-manager", RunLimits(6, 5, 500))

class HermesMobileTest {
    private val skills = SkillRegistry.fromTexts(listOf(SKILL))

    @Test fun `loop executes tools, injects the grant, and finishes with text`() = runBlocking {
        val model = FakeModel(listOf(
            listOf(ModelEvent.ToolCalls(listOf(ToolCall("c1", "skill_view", """{"name":"household-manager"}""")))),
            listOf(ModelEvent.ToolCalls(listOf(ToolCall("c2", "create_task", """{"title":"Mop"}"""))), ModelEvent.Usage(500, 20)),
            listOf(ModelEvent.TextDelta("Done: "), ModelEvent.TextDelta("created a task."), ModelEvent.Usage(600, 15)),
        ))
        val tools = FakeTools()
        val events = mutableListOf<AgentEvent>()
        val r = AgentLoop(model, tools, skills, power()).run(TICKET, emptyList(), "Add a mopping task", events::add)
        assertEquals("completed", r.status)
        assertEquals("Done: created a task.", r.output)
        assertEquals(2, r.toolCalls)
        assertEquals(1100, r.inputTokens)
        // The grant goes to the tool, never to the model.
        assertTrue(tools.calls.single().second.contains(TICKET.grant))
        assertFalse(model.sent.flatten().any { it.content?.contains(TICKET.grant) == true })
        // Progressive loading: the system prompt lists the skill; the body arrives only via skill_view.
        assertTrue(model.sent[0][0].content!!.contains("- household-manager: Coordinates everyday household work."))
        assertFalse(model.sent[0][0].content!!.contains("## Procedure"))
        assertTrue(model.sent[1].last().content!!.contains("## Procedure"))
        assertTrue(events.any { it is AgentEvent.ToolStarted && it.name == "create_task" })
    }

    @Test fun `independent read-only calls run in parallel and outputs are truncated`() = runBlocking {
        val model = FakeModel(listOf(
            listOf(ModelEvent.ToolCalls(listOf(ToolCall("a", "list_tasks", "{}"), ToolCall("b", "get_low_stock_items", "{}")))),
            listOf(ModelEvent.TextDelta("ok")),
        ))
        val tools = FakeTools(delayMs = 50)
        AgentLoop(model, tools, skills, power()).run(TICKET, emptyList(), "status", {})
        assertEquals(2, tools.maxConcurrent)
        val toolMsgs = model.sent[1].filter { it.role == "tool" }
        assertTrue(toolMsgs.all { it.content!!.length < 600 && it.content!!.contains("truncated") })
    }

    @Test fun `tool-call budget and iteration budget are enforced, ending with a summary`() = runBlocking {
        val loopForever = listOf(ModelEvent.ToolCalls(listOf(ToolCall("x", "list_tasks", "{}"))))
        val model = FakeModel(listOf(loopForever, loopForever, loopForever, loopForever, loopForever, loopForever, listOf(ModelEvent.TextDelta("Summary."))))
        val tools = FakeTools()
        val r = AgentLoop(model, tools, skills, power()).run(TICKET, emptyList(), "go", {})
        assertEquals(6, r.iterations)
        assertTrue(tools.calls.size <= TICKET.limits.maxToolCalls)
        assertEquals("Summary.", r.output)
        assertEquals("simple", model.tiers.last()) // the closing summary uses the economical tier
    }

    @Test fun `critical battery stops the loop before any model call`() = runBlocking {
        val model = FakeModel(listOf(listOf(ModelEvent.TextDelta("hi"))))
        val r = AgentLoop(model, FakeTools(), skills, power(PowerMode.Critical)).run(TICKET, emptyList(), "go", {})
        assertEquals("cancelled", r.status)
        assertTrue(model.sent.isEmpty())
    }

    @Test fun `model outage fails cleanly`() = runBlocking {
        val model = object : ModelClient {
            override fun complete(messages: List<ChatMessage>, tools: List<ToolSpec>, tier: String): Flow<ModelEvent> = flow { throw ModelUnavailable("down") }
        }
        val r = AgentLoop(model, FakeTools(), skills, power()).run(TICKET, emptyList(), "go", {})
        assertEquals("failed", r.status)
        assertEquals("down", r.error)
    }

    @Test fun `context compaction shrinks old tool outputs without a model call`() {
        val loop = AgentLoop(FakeModel(listOf(emptyList())), FakeTools(), skills, power(), maxContextChars = 2000)
        val msgs = mutableListOf(ChatMessage("system", "s")) + (1..8).map { ChatMessage("tool", "y".repeat(800), toolCallId = "$it") }
        val m = msgs.toMutableList()
        loop.compactInPlace(m)
        assertTrue(m.sumOf { it.content?.length ?: 0 } <= 2000 + 800 * 4)
        assertTrue(m[1].content!!.contains("compacted"))
        assertEquals(800, m.last().content!!.length) // recent results kept verbatim
    }

    @Test fun `delegation runs a bounded helper on the economical tier`() = runBlocking {
        val bigTicket = TICKET.copy(limits = RunLimits(12, 20, 2000))
        val model = FakeModel(listOf(
            listOf(ModelEvent.ToolCalls(listOf(ToolCall("d", "delegate_task", """{"task":"Count open tasks"}""")))),
            listOf(ModelEvent.ToolCalls(listOf(ToolCall("h1", "list_tasks", "{}")))), // helper turn 1
            listOf(ModelEvent.TextDelta("3 open")),                                     // helper result
            listOf(ModelEvent.TextDelta("You have 3 open tasks.")),                      // orchestrator final
        ))
        val r = AgentLoop(model, FakeTools(), skills, power()).run(bigTicket, emptyList(), "how many tasks?", {})
        assertEquals("You have 3 open tasks.", r.output)
        assertEquals(listOf("complex", "simple", "simple", "complex"), model.tiers)
    }

    @Test fun `stream chunks reassemble fragmented tool calls and usage`() {
        val acc = ChunkAccumulator()
        val ev = mutableListOf<ModelEvent>()
        ev += acc.accept("""{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"create_","arguments":"{\"ti"}}]}}]}""")
        ev += acc.accept("""{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"task","arguments":"tle\":\"Mop\"}"}}]}}]}""")
        ev += acc.accept("""{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}""")
        ev += acc.finish()
        val calls = (ev.last() as ModelEvent.ToolCalls).calls
        assertEquals("create_task", calls.single().name)
        assertEquals("""{"title":"Mop"}""", calls.single().argumentsJson)
        assertTrue(ev.contains(ModelEvent.Usage(12, 3)))
    }

    @Test fun `skill files parse exactly as the server Hermes reads them`() {
        val s = SkillRegistry.parse(SKILL)!!
        assertEquals("household-manager", s.name)
        assertTrue(s.body.startsWith("# Household manager"))
    }

    @Test fun `offline intents need no model call`() {
        assertEquals(OfflineIntent.AddToList("Milk", 2.0, "l"), OfflineIntents.parse("add 2 l milk to the shopping list"))
        assertEquals(OfflineIntent.AddToList("Eggs", 1.0, "pcs"), OfflineIntents.parse("buy eggs"))
        assertEquals(OfflineIntent.DueToday, OfflineIntents.parse("What's due today?"))
        assertEquals(OfflineIntent.CompleteTask("water plants"), OfflineIntents.parse("mark water plants as done"))
        assertEquals(OfflineIntent.AddTask("Call the plumber"), OfflineIntents.parse("remind me to call the plumber"))
        assertEquals(null, OfflineIntents.parse("prepare everything for next week"))
        assertEquals(null, OfflineIntents.parse("add rice, dal and onions for the party on saturday"))
    }

    @Test fun `power modes gate foreground and background work`() {
        assertEquals(PowerMode.Critical, PowerSnapshot(4, false, false, 0, true).mode)
        assertEquals(PowerMode.Saver, PowerSnapshot(60, false, true, 0, true).mode)
        assertEquals(PowerMode.Saver, PowerSnapshot(60, false, false, 2, true).mode) // moderate heat
        assertEquals(PowerMode.Normal, PowerSnapshot(10, true, false, 0, true).mode) // charging
        assertTrue(PowerSnapshot(50, true, false, 0, true).allowsBackgroundAgent)
        assertFalse(PowerSnapshot(90, false, false, 0, true).allowsBackgroundAgent) // not charging
        assertFalse(PowerSnapshot(90, true, false, 0, false).allowsBackgroundAgent) // metered
        assertFalse(PowerSnapshot(90, true, false, 4, true).allowsForegroundAgent) // severe heat
    }
}
