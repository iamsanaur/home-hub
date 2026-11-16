import Foundation
import FirebaseAuth
import FirebaseAppCheck

struct GatewayError: LocalizedError {
    let status: Int, code: String, message: String
    var errorDescription: String? { message }
    var isAgentUnavailable: Bool { code == "agent_unavailable" }
}

/// HomeHub API gateway client. Fresh Firebase ID token (+ App Check outside the emulator) on every call.
/// The Hermes server and model provider are never contacted directly.
actor Gateway {
    static let shared = Gateway()

    func authHeaders() async throws -> [String: String] {
        guard let user = Auth.auth().currentUser else { throw GatewayError(status: 401, code: "unauthenticated", message: "Sign in required") }
        let token = try await user.getIDToken()
        var h = ["Authorization": "Bearer \(token)"]
        if !FirebaseBootstrap.usingEmulators, let ac = try? await AppCheck.appCheck().token(forcingRefresh: false) { h["X-Firebase-AppCheck"] = ac.token }
        return h
    }

    @discardableResult
    func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: FirebaseBootstrap.gatewayBaseURL + path)!)
        req.httpMethod = method
        req.timeoutInterval = 30
        for (k, v) in try await authHeaders() { req.setValue(v, forHTTPHeaderField: k) }
        if let body { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let data: Data, res: URLResponse
        do { (data, res) = try await URLSession.shared.data(for: req) }
        catch { throw GatewayError(status: 0, code: "network", message: "You're offline or the server can't be reached. Try again.") }
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(status) else {
            let e = json["error"] as? [String: Any]
            throw GatewayError(status: status, code: e?["code"] as? String ?? "http_\(status)", message: e?["message"] as? String ?? "Something went wrong (\(status)).")
        }
        return json
    }
}
