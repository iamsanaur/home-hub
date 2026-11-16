import SwiftUI
import FirebaseAuth

/// Settings → Your profile: how you appear to the household. Saved on the server for every household you belong to.
struct ProfileSettingsSection: View {
    let h: HouseholdContext
    @State private var editing = false

    private var current: String { h.me?.displayName ?? "" }
    private var email: String? { Auth.auth().currentUser?.email }
    private var looksLikeEmail: Bool { current.contains("@") }

    var body: some View {
        SectionHeader(title: "Your profile")
        GroupedList {
            Button { editing = true } label: {
                HHListRow(title: current.isEmpty || looksLikeEmail ? "Add your name" : current, subtitle: email, systemImage: "person.crop.circle",
                          trailing: AnyView(Text("Edit").font(HHFont.label).foregroundStyle(HH.brand)))
            }.buttonStyle(.plain)
        }
        .sheet(isPresented: $editing) { EditNameSheet(initial: looksLikeEmail ? "" : current, current: current) }
    }
}

private struct EditNameSheet: View {
    let initial: String
    let current: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    HHTextField(label: "Name", text: $name, helper: "Shown to everyone in your households, instead of your email.", error: error)
                    HHButton(title: "Save", loading: saving) {
                        saving = true; error = nil
                        Task {
                            do {
                                try await Gateway.shared.call("PATCH", "/v1/me", body: ["displayName": name.trimmingCharacters(in: .whitespaces)])
                                try? await Auth.auth().currentUser?.reload()
                                dismiss()
                            } catch { self.error = error.localizedDescription; saving = false }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || name.trimmingCharacters(in: .whitespaces) == current)
                }.padding(Space.lg)
            }
            .background(HH.canvas)
            .navigationTitle("Your name").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
        .onAppear { name = initial }
    }
}
