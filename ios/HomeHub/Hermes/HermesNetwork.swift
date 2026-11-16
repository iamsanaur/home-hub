import Foundation
import Network
import UIKit
import BackgroundTasks

/// Reassembles streamed OpenAI chat.completion.chunk frames (text deltas + fragmented tool calls).
final class ChunkAccumulator {
    private var ids: [Int: String] = [:], names: [Int: String] = [:], args: [Int: String] = [:]

    func accept(_ data: String) -> [ModelEvent] {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] else { return [] }
        var out: [ModelEvent] = []
        if let u = o["usage"] as? [String: Any] { out.append(.usage(input: u["prompt_tokens"] as? Int ?? 0, output: u["completion_tokens"] as? Int ?? 0)) }
        guard let delta = ((o["choices"] as? [[String: Any]])?.first)?["delta"] as? [String: Any] else { return out }
        if let c = delta["content"] as? String, !c.isEmpty { out.append(.text(c)) }
        for tc in delta["tool_calls"] as? [[String: Any]] ?? [] {
            let i = tc["index"] as? Int ?? 0
            if let id = tc["id"] as? String { ids[i] = id }
            if let fn = tc["function"] as? [String: Any] {
                if let n = fn["name"] as? String { names[i, default: ""] += n }
                if let a = fn["arguments"] as? String { args[i, default: ""] += a }
            }
        }
        return out
    }

    func finish() -> [ModelEvent] {
        guard !names.isEmpty else { return [] }
        return [.toolCalls(names.keys.sorted().map { i in ToolCall(id: ids[i] ?? "call_\(i)", name: names[i]!, argumentsJSON: (args[i] ?? "").isEmpty ? "{}" : args[i]!) })]
    }
}

/// Model calls go to the HomeHub proxy; the phone never holds a provider key or chooses the model.
struct ProxyModelClient: ModelClient {
    let url: URL
    let headers: () async throws -> [String: String]

    static func encode(_ m: [ChatMessage]) -> [[String: Any]] {
        m.map { msg in
            var o: [String: Any] = ["role": msg.role, "content": msg.content ?? NSNull()]
            if !msg.toolCalls.isEmpty { o["tool_calls"] = msg.toolCalls.map { ["id": $0.id, "type": "function", "function": ["name": $0.name, "arguments": $0.argumentsJSON]] } }
            if let id = msg.toolCallId { o["tool_call_id"] = id }
            return o
        }
    }

    func complete(_ messages: [ChatMessage], tools: [ToolSpec], tier: String) -> AsyncThrowingStream<ModelEvent, Error> {
        AsyncThrowingStream { cont in
            let task = Task {
                do {
                    var req = URLRequest(url: url)
                    req.httpMethod = "POST"
                    req.timeoutInterval = 90
                    for (k, v) in try await headers() { req.setValue(v, forHTTPHeaderField: k) }
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    var body: [String: Any] = ["tier": tier, "messages": Self.encode(messages)]
                    if !tools.isEmpty { body["tools"] = tools.map { ["type": "function", "function": ["name": $0.name, "description": $0.description, "parameters": $0.parameters]] } }
                    req.httpBody = try JSONSerialization.data(withJSONObject: body)
                    let (bytes, res) = try await URLSession.shared.bytes(for: req)
                    let status = (res as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else {
                        var raw = Data(); for try await b in bytes { raw.append(b) }
                        let e = ((try? JSONSerialization.jsonObject(with: raw)) as? [String: Any])?["error"] as? [String: Any]
                        throw ModelUnavailable(message: e?["message"] as? String ?? "The assistant's model returned \(status).", code: e?["code"] as? String ?? "model_error")
                    }
                    let acc = ChunkAccumulator()
                    for try await line in bytes.lines where line.hasPrefix("data:") {
                        let data = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        if data == "[DONE]" { break }
                        acc.accept(data).forEach { cont.yield($0) }
                    }
                    acc.finish().forEach { cont.yield($0) }
                    cont.finish()
                } catch let e as ModelUnavailable { cont.finish(throwing: e) }
                catch is CancellationError { cont.finish(throwing: CancellationError()) }
                catch { cont.finish(throwing: ModelUnavailable(message: "Lost connection to the assistant's model.")) }
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}

/// Minimal MCP (Streamable HTTP) client authenticated with the user's Firebase ID token.
final class McpToolHost: ToolHost {
    let url: URL
    let headers: () async throws -> [String: String]
    private var nextId = 1
    private var cached: [ToolSpec]?
    init(url: URL, headers: @escaping () async throws -> [String: String]) { self.url = url; self.headers = headers }

    private func rpc(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"; req.timeoutInterval = 30
        for (k, v) in try await headers() { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        nextId += 1
        req.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": nextId, "method": method, "params": params])
        let (data, res) = try await URLSession.shared.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw ModelUnavailable(message: "Household tools unavailable.", code: "tools_unavailable") }
        var text = String(decoding: data, as: UTF8.self)
        if !text.trimmingCharacters(in: .whitespaces).hasPrefix("{") { text = text.split(separator: "\n").filter { $0.hasPrefix("data:") }.map { $0.dropFirst(5).trimmingCharacters(in: .whitespaces) }.joined() }
        guard let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { throw ModelUnavailable(message: "Bad tool response", code: "tools_error") }
        if let e = o["error"] as? [String: Any] { throw ModelUnavailable(message: e["message"] as? String ?? "Tool error", code: "tools_error") }
        return o["result"] as? [String: Any] ?? [:]
    }

    func listTools() async throws -> [ToolSpec] {
        if let cached { return cached }
        let tools = (try await rpc("tools/list", [:])["tools"] as? [[String: Any]] ?? []).map { t -> ToolSpec in
            var schema = t["inputSchema"] as? [String: Any] ?? [:]
            // The grant is injected by the runtime, never chosen by the model.
            if var props = schema["properties"] as? [String: Any] { props.removeValue(forKey: "grant"); schema["properties"] = props }
            if let req = schema["required"] as? [String] { schema["required"] = req.filter { $0 != "grant" } }
            return ToolSpec(name: t["name"] as? String ?? "", description: t["description"] as? String ?? "", parameters: schema,
                            readOnly: (t["annotations"] as? [String: Any])?["readOnlyHint"] as? Bool ?? false)
        }
        cached = tools
        return tools
    }

    func call(_ name: String, argumentsJSON: String) async -> String {
        do {
            let args = (try? JSONSerialization.jsonObject(with: Data(argumentsJSON.utf8))) as? [String: Any] ?? [:]
            let r = try await rpc("tools/call", ["name": name, "arguments": args])
            return ((r["content"] as? [[String: Any]])?.first?["text"] as? String) ?? "{}"
        } catch {
            return #"{"ok":false,"error":{"code":"tools_unavailable","message":"\#(error.localizedDescription.replacingOccurrences(of: "\"", with: "'"))"}}"#
        }
    }
}

/// Battery, Low Power Mode, thermal state and network cost — read on demand, no polling.
final class IOSPower: PowerSource {
    static let shared = IOSPower()
    private let monitor = NWPathMonitor()
    private var expensive = true
    private init() {
        monitor.pathUpdateHandler = { [weak self] p in self?.expensive = p.isExpensive || p.isConstrained }
        monitor.start(queue: DispatchQueue(label: "homehub.power.path"))
    }
    func snapshot() -> PowerSnapshot {
        let read: () -> PowerSnapshot = {
            UIDevice.current.isBatteryMonitoringEnabled = true
            let level = UIDevice.current.batteryLevel
            let state = UIDevice.current.batteryState
            let thermal: Int
            switch ProcessInfo.processInfo.thermalState { case .nominal: thermal = 0; case .fair: thermal = 1; case .serious: thermal = 4; case .critical: thermal = 6; @unknown default: thermal = 0 }
            return PowerSnapshot(levelPercent: level < 0 ? nil : Int(level * 100), charging: state == .charging || state == .full,
                                 powerSaver: ProcessInfo.processInfo.isLowPowerModeEnabled, thermal: thermal, unmetered: !self.expensive)
        }
        return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
    }
}

/// What the person sees at the end of a run — from the SERVER's verification, not the model's text.
struct RunOutcome {
    let workflowId: String?, sessionId: String?, state: String, text: String
    let verifiedActions: [String], approvalIds: [String]
    var deterministicSummary: String? = nil
    var error: String? = nil
}

/// Hermes Mobile facade: ticket from the gateway → loop on the phone → server-verified completion.
final class HermesMobile {
    static let shared = HermesMobile()
    let skills = SkillRegistry.bundled()
    let power: PowerSource = IOSPower.shared

    private func headers() async throws -> [String: String] { try await Gateway.shared.authHeaders() }

    func run(hid: String, message: String, sessionId: String?, history: [ChatMessage], emit: @escaping (AgentEvent) -> Void) async throws -> RunOutcome {
        let snap = power.snapshot()
        guard snap.allowsForegroundAgent else {
            return RunOutcome(workflowId: nil, sessionId: sessionId, state: "cancelled", text: "", verifiedActions: [], approvalIds: [], error: "Your phone is critically low on battery or too warm. Try again once it's charging or cooler.")
        }
        var body: [String: Any] = ["message": message, "power": snap.mode.rawValue]
        if let sessionId { body["sessionId"] = sessionId }
        let start = try await Gateway.shared.call("POST", "/v1/households/\(hid)/agent/device-runs", body: body)
        let sid = start["sessionId"] as? String, wid = start["workflowId"] as? String ?? ""
        if start["mode"] as? String == "deterministic" {
            let summary = (start["answer"] as? [String: Any])?["summary"] as? String ?? "Here's what I found."
            return RunOutcome(workflowId: wid, sessionId: sid, state: "deterministic", text: summary, verifiedActions: [], approvalIds: [], deterministicSummary: summary)
        }
        let l = start["limits"] as? [String: Any] ?? [:]
        let ticket = RunTicket(workflowId: wid, sessionId: sid ?? "", instructions: start["instructions"] as? String ?? "", grant: start["grant"] as? String ?? "",
                               tier: start["tier"] as? String ?? "simple", skill: start["skill"] as? String ?? "household-manager",
                               limits: RunLimits(maxIterations: l["maxIterations"] as? Int ?? 8, maxToolCalls: l["maxToolCalls"] as? Int ?? 30, toolOutputChars: l["toolOutputChars"] as? Int ?? 4000))
        if snap.mode == .saver { emit(.note("Battery saver: using a lighter plan.")) }
        let loop = AgentLoop(model: ProxyModelClient(url: URL(string: "\(FirebaseBootstrap.gatewayBaseURL)/v1/households/\(hid)/agent/workflows/\(wid)/model")!, headers: headers),
                             tools: McpToolHost(url: URL(string: FirebaseBootstrap.mcpURL)!, headers: headers), skills: skills, power: power)
        let result = await loop.run(ticket, history: history, user: message, emit: emit)
        let status = ["completed", "failed", "cancelled"].contains(result.status) ? result.status : "failed"
        var complete: [String: Any] = ["status": status, "output": String(result.output.prefix(20000)), "toolCalls": result.toolCalls]
        if let e = result.error { complete["error"] = String(e.prefix(500)) }
        let done = (try? await Gateway.shared.call("POST", "/v1/households/\(hid)/agent/workflows/\(wid)/complete", body: complete)) ?? [:]
        return RunOutcome(workflowId: wid, sessionId: sid, state: done["state"] as? String ?? status, text: result.output,
                          verifiedActions: (done["verified"] as? [[String: Any]] ?? []).compactMap { $0["action"] as? String },
                          approvalIds: (done["approvals"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }, error: result.error)
    }
}

/// Scheduled agent jobs on iOS: BGProcessingTask that only runs on external power with network.
/// If the system never grants a window, the server Hermes runs the job after its grace period.
enum HermesBackgroundJobs {
    static let taskId = "com.e404.homehub.hermes.jobs"
    static var householdId: String? {
        get { UserDefaults.standard.string(forKey: "hermes.jobs.hid") }
        set { UserDefaults.standard.set(newValue, forKey: "hermes.jobs.hid") }
    }

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let task = task as? BGProcessingTask else { return }
            schedule()
            let work = Task {
                defer { task.setTaskCompleted(success: true) }
                guard let hid = householdId, IOSPower.shared.snapshot().allowsBackgroundAgent else { return }
                guard let claim = try? await Gateway.shared.call("POST", "/v1/households/\(hid)/jobs/weekly_meal_planning/device-claim"),
                      claim["claimed"] as? Bool == true, let message = claim["message"] as? String else { return }
                _ = try? await HermesMobile.shared.run(hid: hid, message: message, sessionId: nil, history: []) { _ in }
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    static func schedule() {
        let req = BGProcessingTaskRequest(identifier: taskId)
        req.requiresExternalPower = true
        req.requiresNetworkConnectivity = true
        req.earliestBeginDate = Date(timeIntervalSinceNow: 6 * 3600)
        try? BGTaskScheduler.shared.submit(req)
    }
}
