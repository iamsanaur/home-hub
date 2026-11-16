import Foundation

struct RunLimits { let maxIterations: Int, maxToolCalls: Int, toolOutputChars: Int }
struct RunTicket { let workflowId: String, sessionId: String, instructions: String, grant: String, tier: String, skill: String, limits: RunLimits }

enum AgentEvent { case delta(String), toolStarted(String), toolFinished(String, ok: Bool), note(String) }

struct LoopResult { let status: String, output: String, toolCalls: Int, iterations: Int, inputTokens: Int, outputTokens: Int; var error: String? = nil }

/// Hermes Mobile agent loop (Swift). Mirrors android/.../hermes/AgentLoop.kt:
/// progressive skill loading, bounded iterations/tool calls, parallel read-only calls,
/// tool-output truncation, structural context compaction, rare bounded delegation,
/// grant injected by the runtime (never shown to the model), battery stop.
final class AgentLoop {
    let model: ModelClient, tools: ToolHost, skills: SkillRegistry, power: PowerSource
    let maxContextChars: Int

    static let skillView = "skill_view", todo = "todo", delegate = "delegate_task"

    init(model: ModelClient, tools: ToolHost, skills: SkillRegistry, power: PowerSource, maxContextChars: Int = 24_000) {
        self.model = model; self.tools = tools; self.skills = skills; self.power = power; self.maxContextChars = maxContextChars
    }

    func run(_ t: RunTicket, history: [ChatMessage], user: String, emit: @escaping (AgentEvent) -> Void) async -> LoopResult {
        let remote: [ToolSpec]
        do { remote = try await tools.listTools() } catch { return LoopResult(status: "failed", output: "", toolCalls: 0, iterations: 0, inputTokens: 0, outputTokens: 0, error: error.localizedDescription) }
        let readOnly = Set(remote.filter(\.readOnly).map(\.name)).union([Self.skillView, Self.todo])
        let specs = builtinSpecs(delegation: t.limits.maxIterations >= 10) + remote
        var messages = [ChatMessage(role: "system", content: t.instructions + "\n\nAvailable skills (load with skill_view before following one):\n" + skills.index()
                                    + "\n\nYou are running on the user's phone. Be economical: batch independent reads in one turn, avoid unnecessary calls, and stop as soon as the goal is met.")]
        messages += history.suffix(6).filter { $0.role == "user" || ($0.role == "assistant" && $0.toolCalls.isEmpty) }.map { ChatMessage(role: $0.role, content: $0.content.map { String($0.prefix(1200)) }) }
        messages.append(ChatMessage(role: "user", content: user))
        return await loop(t, &messages, specs, readOnly, t.limits.maxIterations, t.tier, emit, depth: 0)
    }

    private func builtinSpecs(delegation: Bool) -> [ToolSpec] {
        func schema(_ props: [String: String], _ req: [String]) -> [String: Any] {
            ["type": "object", "properties": props.mapValues { ["type": "string", "description": $0] }, "required": req]
        }
        var s = [ToolSpec(name: Self.skillView, description: "Load the full procedure of a skill by name before acting.", parameters: schema(["name": "Skill name"], ["name"]), readOnly: true),
                 ToolSpec(name: Self.todo, description: "Record a short plan (newline-separated steps) for multi-step work.", parameters: schema(["plan": "Steps, one per line"], ["plan"]), readOnly: true)]
        if delegation { s.append(ToolSpec(name: Self.delegate, description: "Hand ONE large, self-contained sub-task to a focused helper with its own short context. Use rarely.", parameters: schema(["task": "What the helper must do", "skill": "Skill the helper should load"], ["task"]), readOnly: false)) }
        return s
    }

    private func loop(_ t: RunTicket, _ messages: inout [ChatMessage], _ specs: [ToolSpec], _ readOnly: Set<String>, _ maxIterations: Int, _ tier: String, _ emit: @escaping (AgentEvent) -> Void, depth: Int) async -> LoopResult {
        var toolCalls = 0, inTok = 0, outTok = 0, iterations = 0
        var output = ""
        while iterations < maxIterations {
            if Task.isCancelled { return LoopResult(status: "cancelled", output: output, toolCalls: toolCalls, iterations: iterations, inputTokens: inTok, outputTokens: outTok) }
            if !power.snapshot().allowsForegroundAgent {
                return LoopResult(status: "cancelled", output: output, toolCalls: toolCalls, iterations: iterations, inputTokens: inTok, outputTokens: outTok, error: "Stopped to protect the battery (critically low or overheating).")
            }
            iterations += 1
            compact(&messages)
            var text = "", calls: [ToolCall] = []
            do {
                for try await e in model.complete(messages, tools: specs, tier: tier) {
                    switch e {
                    case .text(let d): text += d; if depth == 0 { emit(.delta(d)) }
                    case .toolCalls(let c): calls = c
                    case .usage(let i, let o): inTok += i; outTok += o
                    }
                }
            } catch {
                return LoopResult(status: "failed", output: output + text, toolCalls: toolCalls, iterations: iterations, inputTokens: inTok, outputTokens: outTok, error: error.localizedDescription)
            }
            if calls.isEmpty {
                output += text
                return LoopResult(status: "completed", output: output.trimmingCharacters(in: .whitespacesAndNewlines), toolCalls: toolCalls, iterations: iterations, inputTokens: inTok, outputTokens: outTok)
            }
            messages.append(ChatMessage(role: "assistant", content: text.isEmpty ? nil : text, toolCalls: calls))
            if toolCalls + calls.count > t.limits.maxToolCalls {
                calls.forEach { messages.append(ChatMessage(role: "tool", content: #"{"ok":false,"error":{"code":"tool_budget_exceeded","message":"Stop and summarise."}}"#, toolCallId: $0.id)) }
                continue
            }
            toolCalls += calls.count
            var results: [(ToolCall, String)] = []
            if calls.count > 1 && calls.allSatisfy({ readOnly.contains($0.name) }) {
                // Independent reads concurrently: fewer, shorter radio bursts.
                results = await withTaskGroup(of: (Int, String).self) { group in
                    for (i, c) in calls.enumerated() { group.addTask { (i, await self.exec(t, c, specs, readOnly, emit, depth)) } }
                    var out = [(Int, String)]()
                    for await r in group { out.append(r) }
                    return out.sorted { $0.0 < $1.0 }.map { (calls[$0.0], $0.1) }
                }
            } else {
                for c in calls { results.append((c, await exec(t, c, specs, readOnly, emit, depth))) }
            }
            for (c, r) in results { messages.append(ChatMessage(role: "tool", content: Self.truncate(r, t.limits.toolOutputChars), toolCallId: c.id)) }
        }
        messages.append(ChatMessage(role: "user", content: "Iteration budget reached. Summarise what was done (verified) and what remains, without calling tools."))
        var summary = ""
        if let stream = Optional(model.complete(messages, tools: [], tier: "simple")) {
            do { for try await e in stream { if case .text(let d) = e { summary += d; if depth == 0 { emit(.delta(d)) } } else if case .usage(let i, let o) = e { inTok += i; outTok += o } } } catch {}
        }
        return LoopResult(status: "completed", output: summary.trimmingCharacters(in: .whitespacesAndNewlines), toolCalls: toolCalls, iterations: iterations, inputTokens: inTok, outputTokens: outTok)
    }

    private func exec(_ t: RunTicket, _ c: ToolCall, _ specs: [ToolSpec], _ readOnly: Set<String>, _ emit: @escaping (AgentEvent) -> Void, _ depth: Int) async -> String {
        if depth == 0 { emit(.toolStarted(c.name)) }
        let args = (try? JSONSerialization.jsonObject(with: Data(c.argumentsJSON.utf8))) as? [String: Any] ?? [:]
        var result: String
        switch c.name {
        case Self.skillView:
            if let body = skills.view(args["name"] as? String ?? ""), let data = try? JSONSerialization.data(withJSONObject: ["ok": true, "skill": body]) { result = String(decoding: data, as: UTF8.self) }
            else { result = #"{"ok":false,"error":{"code":"unknown_skill","message":"Known skills: \#(skills.names.joined(separator: ", "))"}}"# }
        case Self.todo: result = #"{"ok":true,"saved":true}"#
        case Self.delegate:
            result = depth > 0 ? #"{"ok":false,"error":{"code":"no_nested_delegation","message":"Helpers cannot delegate."}}"# : await delegateTask(t, args, specs, readOnly, emit)
        default:
            var withGrant = args; withGrant["grant"] = t.grant   // injected by the runtime; the model never sees it
            let json = (try? JSONSerialization.data(withJSONObject: withGrant)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
            result = await tools.call(c.name, argumentsJSON: json)
        }
        let ok = !result.contains("\"ok\":false") || result.contains("approval_required")
        if depth == 0 { emit(.toolFinished(c.name, ok: ok)) }
        return result
    }

    private func delegateTask(_ t: RunTicket, _ args: [String: Any], _ specs: [ToolSpec], _ readOnly: Set<String>, _ emit: @escaping (AgentEvent) -> Void) async -> String {
        guard let task = args["task"] as? String else { return #"{"ok":false,"error":{"code":"invalid_argument","message":"task is required"}}"# }
        emit(.note("Delegating: \(task.prefix(80))"))
        let skill = (args["skill"] as? String).flatMap { skills.view($0) }
        let rules = t.instructions.split(separator: "\n").filter { !$0.hasPrefix("hhg_") }.joined(separator: "\n").prefix(3000)
        var sub = [ChatMessage(role: "system", content: "You are a focused HomeHub helper. Complete only this sub-task with the tools, then reply with a short factual result.\n\(rules)" + (skill.map { "\n\nSkill:\n\($0)" } ?? "")),
                   ChatMessage(role: "user", content: task)]
        let r = await loop(t, &sub, specs.filter { $0.name != Self.delegate }, readOnly, 4, "simple", emit, depth: 1)
        let data = (try? JSONSerialization.data(withJSONObject: ["ok": r.status == "completed", "result": String(r.output.prefix(1500)), "toolCalls": r.toolCalls])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    /// Older tool results shrink to stubs once the context is large (no extra model call).
    func compact(_ messages: inout [ChatMessage]) {
        var total = messages.reduce(0) { $0 + ($1.content?.count ?? 0) }
        guard total > maxContextChars else { return }
        for i in messages.indices where total > maxContextChars && i < messages.count - 4 {
            let m = messages[i]
            if m.role == "tool", let c = m.content, c.count > 300 {
                let stub = String(c.prefix(240)) + "…[older result compacted: \(c.count - 240) chars removed]"
                total -= c.count - stub.count
                messages[i] = ChatMessage(role: "tool", content: stub, toolCallId: m.toolCallId)
            }
        }
    }

    static func truncate(_ s: String, _ max: Int) -> String { s.count <= max ? s : String(s.prefix(max)) + "…[truncated \(s.count - max) chars; ask for a narrower query]" }
}
