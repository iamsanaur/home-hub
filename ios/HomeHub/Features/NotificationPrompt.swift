import SwiftUI
import UserNotifications

/// Push registration: ask only from a clear, contextual moment (the Home card), then register with
/// APNs so FCM can deliver. When permission already exists, register at launch to keep tokens fresh.
enum PushRegistration {
    static func status() async -> UNAuthorizationStatus { await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }

    @MainActor static func registerIfAuthorized() async {
        let s = await status()
        if s == .authorized || s == .provisional || s == .ephemeral { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// Returns true when notifications end up allowed.
    @MainActor static func request() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }
}

/// Home card that offers notifications until they're on or the person chooses "Not now".
/// If they were denied before, "Turn on" opens the app's Settings page (iOS won't ask twice).
struct NotificationPrompt: View {
    @AppStorage("homehub.notificationPromptDismissed") private var dismissed = false
    @Environment(\.scenePhase) private var phase
    @Environment(\.openURL) private var openURL
    @State private var status: UNAuthorizationStatus?

    var body: some View {
        // A VStack with an always-present zero-height anchor, so the status check runs even while the card is hidden.
        VStack(spacing: 0) {
            Color.clear.frame(height: 0).accessibilityHidden(true)
            if !dismissed, let status, status == .notDetermined || status == .denied {
                HHCard {
                    Label("Get reminders on this phone", systemImage: "bell.badge").font(HHFont.cardTitle).foregroundStyle(HH.ink)
                    Text("HomeHub can tell you about bills due, overdue tasks, low stock and requests waiting for your approval. You choose which ones in Settings.")
                        .font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                    HStack(spacing: Space.sm) {
                        HHButton(title: "Turn on", fullWidth: false) {
                            if status == .denied, let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                            else { Task { _ = await PushRegistration.request(); self.status = await PushRegistration.status() } }
                        }
                        HHButton(title: "Not now", kind: .tertiary, fullWidth: false) { dismissed = true }
                    }
                }
                .padding(.top, Space.md)
            }
        }
        .task(id: phase) { if phase == .active { status = await PushRegistration.status() } }
    }
}
