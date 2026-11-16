import SwiftUI
import SwiftData
import FirebaseCore
import FirebaseMessaging
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, MessagingDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        FirebaseBootstrap.configure()
        HermesBackgroundJobs.register()
        UNUserNotificationCenter.current().delegate = self
        if !FirebaseBootstrap.usingEmulators {
            Messaging.messaging().delegate = self
            Task { await PushRegistration.registerIfAuthorized() }
        }
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if !FirebaseBootstrap.usingEmulators { Messaging.messaging().apnsToken = deviceToken }
    }
    /// Token refresh → re-register with the gateway (APNs via FCM).
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { try? await Gateway.shared.call("POST", "/v1/me/devices", body: ["deviceId": DeviceId.value, "token": fcmToken, "platform": "ios", "appVersion": "1.0.0"]) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let link = response.notification.request.content.userInfo["deepLink"] as? String, let url = URL(string: link) {
            await MainActor.run { DeepLinks.pending = url }
        }
    }
}

enum DeviceId {
    static var value: String {
        if let v = UserDefaults.standard.string(forKey: "homehub.deviceId") { return v }
        let v = UUID().uuidString.replacingOccurrences(of: "-", with: ""); UserDefaults.standard.set(v, forKey: "homehub.deviceId"); return v
    }
}

@MainActor enum DeepLinks { static var pending: URL? }

@main
struct HomeHubApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .modelContainer(model.offline.container)
                .tint(HH.brand)
                .onOpenURL { model.deepLink = $0 }
        }
    }
}
