import XCTest
@testable import HomeHub

private let skillText = """
---
name: household-manager
description: Coordinates everyday household work.
version: 1.0.0
---

# Household manager
## Procedure
1. list_tasks
"""

private final class FakeModel: ModelClient {
    var steps: [[ModelEvent]]; var sent: [[ChatMessage]] = []; var tiers: [String] = []
    init(_ s: [[ModelEvent]]) { steps = s }
    func complete(_ messages: [ChatMessage], tools: [ToolSpec], tier: String) -> AsyncThrowingStream<ModelEvent, Error> {
        sent.append(messages); tiers.append(tier)
        let step = sent.count - 1 < steps.count ? steps[sent.count - 1] : steps.last!
        return AsyncThrowingStream { c in step.forEach { c.yield($0) }; c.finish() }
    }
}

private final class FakeTools: ToolHost {
    var calls: [(String, String)] = []
    func listTools() async throws -> [ToolSpec] {
        [ToolSpec(name: "list_tasks", description: "", parameters: [:], readOnly: true), ToolSpec(name: "get_low_stock_items", description: "", parameters: [:], readOnly: true),
         ToolSpec(name: "create_task", description: "", parameters: [:], readOnly: false)]
    }
    func call(_ name: String, argumentsJSON: String) async -> String {
        calls.append((name, argumentsJSON))
        return name == "create_task" ? #"{"ok":true,"data":{"id":"t1"}}"# : #"{"ok":true,"data":"\#(String(repeating: "x", count: 3000))"}"#
    }
}

private struct FixedPower: PowerSource { let s: PowerSnapshot; func snapshot() -> PowerSnapshot { s } }
private let normal = FixedPower(s: PowerSnapshot(levelPercent: 80, charging: false, powerSaver: false, thermal: 0, unmetered: true))
private let ticket = RunTicket(workflowId: "wf", sessionId: "s", instructions: "You are homehub-hermes.", grant: "hhg_secret_grant_000000000000000000000000000000000",
                               tier: "complex", skill: "household-manager", limits: RunLimits(maxIterations: 6, maxToolCalls: 5, toolOutputChars: 500))

final class HermesMobileTests: XCTestCase {
    let skills = SkillRegistry.from(texts: [skillText])

    func testLoopInjectsGrantLoadsSkillsProgressivelyAndFinishes() async {
        let model = FakeModel([[.toolCalls([ToolCall(id: "1", name: "skill_view", argumentsJSON: #"{"name":"household-manager"}"#)])],
                               [.toolCalls([ToolCall(id: "2", name: "create_task", argumentsJSON: #"{"title":"Mop"}"#)]), .usage(input: 500, output: 20)],
                               [.text("Done."), .usage(input: 600, output: 10)]])
        let tools = FakeTools()
        let r = await AgentLoop(model: model, tools: tools, skills: skills, power: normal).run(ticket, history: [], user: "Add mopping") { _ in }
        XCTAssertEqual(r.status, "completed"); XCTAssertEqual(r.output, "Done."); XCTAssertEqual(r.inputTokens, 1100)
        XCTAssertTrue(tools.calls.first!.1.contains(ticket.grant))
        XCTAssertFalse(model.sent.flatMap { $0 }.contains { $0.content?.contains(ticket.grant) == true })
        XCTAssertTrue(model.sent[0][0].content!.contains("- household-manager: Coordinates everyday household work."))
        XCTAssertFalse(model.sent[0][0].content!.contains("## Procedure"))
        XCTAssertTrue(model.sent[1].last!.content!.contains("## Procedure"))
    }

    func testBudgetsTruncationAndClosingSummaryOnCheapTier() async {
        let forever: [ModelEvent] = [.toolCalls([ToolCall(id: "x", name: "list_tasks", argumentsJSON: "{}")])]
        let model = FakeModel(Array(repeating: forever, count: 6) + [[.text("Summary.")]])
        let tools = FakeTools()
        let r = await AgentLoop(model: model, tools: tools, skills: skills, power: normal).run(ticket, history: [], user: "go") { _ in }
        XCTAssertEqual(r.iterations, 6); XCTAssertLessThanOrEqual(tools.calls.count, 5)
        XCTAssertEqual(r.output, "Summary."); XCTAssertEqual(model.tiers.last, "simple")
        XCTAssertTrue(model.sent[1].last!.content!.contains("truncated"))
    }

    func testCriticalBatteryStopsBeforeAnyModelCall() async {
        let model = FakeModel([[.text("hi")]])
        let critical = FixedPower(s: PowerSnapshot(levelPercent: 3, charging: false, powerSaver: true, thermal: 0, unmetered: false))
        let r = await AgentLoop(model: model, tools: FakeTools(), skills: skills, power: critical).run(ticket, history: [], user: "go") { _ in }
        XCTAssertEqual(r.status, "cancelled"); XCTAssertTrue(model.sent.isEmpty)
    }

    func testChunkAccumulatorReassemblesToolCalls() {
        let acc = ChunkAccumulator()
        var ev = acc.accept(#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"create_","arguments":"{\"ti"}}]}}]}"#)
        ev += acc.accept(#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"task","arguments":"tle\":\"Mop\"}"}}]}}]}"#)
        ev += acc.accept(#"{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#)
        ev += acc.finish()
        XCTAssertEqual(ev.last, .toolCalls([ToolCall(id: "c1", name: "create_task", argumentsJSON: #"{"title":"Mop"}"#)]))
        XCTAssertTrue(ev.contains(.usage(input: 12, output: 3)))
    }

    func testOfflineIntentsAndPowerModesMatchAndroid() {
        XCTAssertEqual(OfflineIntents.parse("add 2 l milk to the shopping list"), .addToList(item: "Milk", quantity: 2, unit: "l"))
        XCTAssertEqual(OfflineIntents.parse("What's due today?"), .dueToday)
        XCTAssertEqual(OfflineIntents.parse("remind me to call the plumber"), .addTask("Call the plumber"))
        XCTAssertNil(OfflineIntents.parse("prepare everything for next week"))
        XCTAssertEqual(PowerSnapshot(levelPercent: 4, charging: false, powerSaver: false, thermal: 0, unmetered: true).mode, .critical)
        XCTAssertEqual(PowerSnapshot(levelPercent: 60, charging: false, powerSaver: true, thermal: 0, unmetered: true).mode, .saver)
        XCTAssertTrue(PowerSnapshot(levelPercent: 50, charging: true, powerSaver: false, thermal: 0, unmetered: true).allowsBackgroundAgent)
        XCTAssertFalse(PowerSnapshot(levelPercent: 90, charging: false, powerSaver: false, thermal: 0, unmetered: true).allowsBackgroundAgent)
    }

    func testMoneyIsExactAndConflictPolicyMatchesAndroid() {
        XCTAssertEqual(Money.parse("1,234.50", currency: "INR"), 123450)
        XCTAssertEqual(Money.parse("1500", currency: "JPY"), 1500)
        XCTAssertNil(Money.parse("1.234", currency: "INR"))
        XCTAssertEqual(Money.percent(8500, of: 10000), 85)
        XCTAssertEqual(ConflictPolicy.decideUpdate(collection: "tasks", baseVersion: 3, remoteExists: true, remoteVersion: 5, changed: ["status", "completedAt", "completedBy"], remote: ["status": "open"]), .apply)
        XCTAssertEqual(ConflictPolicy.decideUpdate(collection: "tasks", baseVersion: 3, remoteExists: true, remoteVersion: 5, changed: ["status", "completedAt", "completedBy"], remote: ["status": "done"]), .alreadyApplied)
        if case .conflict = ConflictPolicy.decideUpdate(collection: "notes", baseVersion: 1, remoteExists: true, remoteVersion: 2, changed: ["body"], remote: [:]) {} else { XCTFail("notes must conflict") }
        XCTAssertEqual(ConflictPolicy.decideCreate(remoteExists: true, remoteClientOpId: "op", opId: "op"), .alreadyApplied)
    }
}
