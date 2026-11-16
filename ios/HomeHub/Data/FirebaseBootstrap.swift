import Foundation
import FirebaseCore
import FirebaseAuth
import FirebaseFirestore
import FirebaseStorage
import FirebaseAppCheck

/// Configures Firebase from GoogleService-Info.plist when present; otherwise a demo
/// configuration wired to the local Emulator Suite. No credentials in source.
enum FirebaseBootstrap {
    static let demoProject = "demo-homehub"
    static let region = "asia-south1"
    static let host = ProcessInfo.processInfo.environment["HOMEHUB_EMULATOR_HOST"] ?? "127.0.0.1"
    private(set) static var usingEmulators = false

    static func configure() {
        guard FirebaseApp.app() == nil else { return }
        if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"), let options = FirebaseOptions(contentsOfFile: path) {
            AppCheck.setAppCheckProviderFactory(AppAttestProviderFactory())
            FirebaseApp.configure(options: options)
            usingEmulators = ProcessInfo.processInfo.environment["HOMEHUB_USE_EMULATORS"] == "1"
        } else {
            let options = FirebaseOptions(googleAppID: "1:000000000000:ios:0000000000000000", gcmSenderID: "000000000000")
            options.projectID = demoProject
            options.apiKey = "AIzaDemoKeyForLocalEmulatorOnly00000000" // format-valid placeholder; emulator only, not a real key
            options.storageBucket = "\(demoProject).appspot.com"
            FirebaseApp.configure(options: options)
            usingEmulators = true
        }
        let settings = FirestoreSettings()
        if usingEmulators {
            Auth.auth().useEmulator(withHost: host, port: 9099)
            settings.host = "\(host):8181"
            settings.isSSLEnabled = false
            Storage.storage().useEmulator(withHost: host, port: 9199)
        }
        settings.cacheSettings = PersistentCacheSettings(sizeBytes: 50 * 1024 * 1024 as NSNumber)
        Firestore.firestore().settings = settings
    }

    static var gatewayBaseURL: String {
        if let url = Bundle.main.object(forInfoDictionaryKey: "HomeHubGatewayURL") as? String, !url.isEmpty { return url }
        if usingEmulators { return "http://\(host):5001/\(demoProject)/\(region)/api" }
        return "https://\(region)-\(FirebaseApp.app()?.options.projectID ?? demoProject).cloudfunctions.net/api"
    }
    static var mcpURL: String { gatewayBaseURL.replacingOccurrences(of: "/api", with: "/mcp") }
}

final class AppAttestProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? { AppAttestProvider(app: app) }
}
