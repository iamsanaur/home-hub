import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        ZStack {
            HH.canvas.ignoresSafeArea()
            switch model.gate {
            case .loading: ProgressView().tint(HH.brand)
            case .signedOut: AuthFlow()
            case .onboarding(let uid, let step, let hid): OnboardingFlow(uid: uid, savedStep: step, hid: hid)
            case .ready(let ctx): MainTabs().environment(\.household, ctx)
            }
        }
    }
}

private struct HouseholdKey: EnvironmentKey { static let defaultValue: HouseholdContext? = nil }
extension EnvironmentValues {
    var household: HouseholdContext? { get { self[HouseholdKey.self] } set { self[HouseholdKey.self] = newValue } }
}

enum Tab: Hashable { case home, manage, ai, family, insights }

/// Five primary destinations. On iOS 26 the system TabView renders Apple's Liquid Glass tab bar
/// (floating, adaptive, with Reduce Transparency handled by the system); on iPad it adapts to a sidebar.
struct MainTabs: View {
    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .home
    var body: some View {
        TabView(selection: $tab) {
            SwiftUI.Tab("Home", systemImage: "house", value: Tab.home) { NavigationStack { HomeView() } }
            SwiftUI.Tab("Manage", systemImage: "square.grid.2x2", value: Tab.manage) { NavigationStack { ManageView() } }
            SwiftUI.Tab("AI", systemImage: "sparkles", value: Tab.ai) { NavigationStack { AIView() } }
            SwiftUI.Tab("Family", systemImage: "person.3", value: Tab.family) { NavigationStack { FamilyView() } }
            SwiftUI.Tab("Insights", systemImage: "chart.line.uptrend.xyaxis", value: Tab.insights) { NavigationStack { InsightsView() } }
        }
        .tabViewStyle(.sidebarAdaptable)
        .onChange(of: model.deepLink) { _, url in
            guard let host = url?.host() else { return }
            tab = ["ai": .ai, "insights": .insights, "family": .family].first { host.hasPrefix($0.key) }?.value ?? (host == "home" ? .home : .manage)
        }
    }
}
