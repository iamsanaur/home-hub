import SwiftUI
import FirebaseAuth
import FirebaseFirestore

struct AuthFlow: View {
    enum Step { case welcome, signIn, signUp, reset }
    @State private var step: Step = .welcome
    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .welcome: Welcome(onSignIn: { step = .signIn }, onCreate: { step = .signUp })
                case .signIn: SignInView(onCreate: { step = .signUp }, onForgot: { step = .reset })
                case .signUp: SignUpView(onHave: { step = .signIn })
                case .reset: ResetView(onDone: { step = .signIn })
                }
            }
            .toolbar { if step != .welcome { ToolbarItem(placement: .topBarLeading) { Button("Back") { step = .welcome } } } }
        }
    }
}

private struct Welcome: View {
    let onSignIn: () -> Void, onCreate: () -> Void
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                Image("BrandMark").resizable().frame(width: 88, height: 88).clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous)).accessibilityLabel("HomeHub logo").padding(.top, Space.xxl)
                VStack(alignment: .leading, spacing: 2) {
                    Text("HomeHub AI").font(HHFont.display).foregroundStyle(HH.ink)
                    Text("Your Agentic Household Manager").font(HHFont.body).foregroundStyle(HH.inkSecondary)
                }
                ForEach([("checklist", "Everything at home, in one place", "Tasks, shopping, meals, bills and maintenance, shared with the people you live with."),
                         ("sparkles", "An assistant that does the busywork", "Plans your week, builds lists and reminders — and shows exactly what it did."),
                         ("checkmark.shield", "You stay in control", "Purchases, payments and bookings always wait for a person to approve them.")], id: \.1) { icon, title, body in
                    HStack(alignment: .top, spacing: Space.md) {
                        Image(systemName: icon).font(.title3).foregroundStyle(HH.brand).frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) { Text(title).font(HHFont.cardTitle).foregroundStyle(HH.ink); Text(body).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary) }
                    }
                }
                .padding(.vertical, 4)
                VStack(spacing: Space.xs) {
                    HHButton(title: "Create account", action: onCreate)
                    HHButton(title: "Sign in", kind: .secondary, action: onSignIn)
                }.padding(.top, Space.lg)
            }
            .frame(maxWidth: 520).padding(.horizontal, Space.xl).frame(maxWidth: .infinity)
        }
        .background(HH.canvas)
    }
}

func friendlyAuthError(_ error: Error) -> String {
    switch AuthErrorCode(rawValue: (error as NSError).code) {
    case .invalidEmail: return "That email address doesn't look right."
    case .wrongPassword, .invalidCredential, .userNotFound: return "Email or password is incorrect."
    case .emailAlreadyInUse: return "An account already exists for this email. Sign in instead."
    case .weakPassword: return "Use at least 8 characters for your password."
    case .networkError: return "You're offline. Check your connection and try again."
    case .tooManyRequests: return "Too many attempts. Wait a minute and try again."
    default: return "Couldn't sign in. Try again."
    }
}

private struct AuthFrame<Content: View>: View {
    let title: String, subtitle: String
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.md) {
                Image("BrandMark").resizable().frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)).accessibilityHidden(true).padding(.top, Space.xl)
                Text(title).font(HHFont.screenTitle).foregroundStyle(HH.ink)
                Text(subtitle).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
                content
            }
            .frame(maxWidth: 520).padding(.horizontal, Space.xl).frame(maxWidth: .infinity)
        }
        .background(HH.canvas)
    }
}

private struct SignInView: View {
    let onCreate: () -> Void, onForgot: () -> Void
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        AuthFrame(title: "Welcome back", subtitle: "Sign in to your household.") {
            HHTextField(label: "Email", text: $email, keyboard: .emailAddress).textInputAutocapitalization(.never).textContentType(.username)
            HHTextField(label: "Password", text: $password, secure: true).textContentType(.password)
            if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            HHButton(title: "Sign in", loading: busy) {
                guard !email.isEmpty, !password.isEmpty else { error = "Enter your email and password."; return }
                busy = true; error = nil
                Task { do { try await Auth.auth().signIn(withEmail: email.trimmingCharacters(in: .whitespaces), password: password) } catch { self.error = friendlyAuthError(error) }; busy = false }
            }
            HStack { Button("Forgot password?", action: onForgot); Spacer(); Button("Create account", action: onCreate) }.font(HHFont.label).foregroundStyle(HH.brand).frame(minHeight: 44)
        }
    }
}

private struct SignUpView: View {
    let onHave: () -> Void
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var tried = false
    @State private var error: String?
    var body: some View {
        AuthFrame(title: "Create your account", subtitle: "It takes a minute. You can invite your household next.") {
            HHTextField(label: "Your name", text: $name, error: tried && name.isEmpty ? "Tell us what to call you." : nil).textContentType(.name)
            HHTextField(label: "Email", text: $email, helper: "Used to sign in and to accept household invitations.", keyboard: .emailAddress).textInputAutocapitalization(.never)
            HHTextField(label: "Password", text: $password, error: tried && password.count < 8 ? "Use at least 8 characters." : nil, secure: true).textContentType(.newPassword)
            if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
            HHButton(title: "Create account", loading: busy) {
                tried = true
                guard !name.isEmpty, !email.isEmpty, password.count >= 8 else { return }
                busy = true; error = nil
                Task {
                    do {
                        let r = try await Auth.auth().createUser(withEmail: email.trimmingCharacters(in: .whitespaces), password: password)
                        let change = r.user.createProfileChangeRequest(); change.displayName = name; try await change.commitChanges()
                        try await Firestore.firestore().document("users/\(r.user.uid)").setData(["displayName": name, "email": email, "onboarding": ["step": "household", "completed": false]], merge: true)
                    } catch { self.error = friendlyAuthError(error) }
                    busy = false
                }
            }
            HHButton(title: "I already have an account", kind: .tertiary, action: onHave)
        }
    }
}

private struct ResetView: View {
    let onDone: () -> Void
    @State private var email = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        AuthFrame(title: "Reset your password", subtitle: "We'll email you a link to choose a new one.") {
            if sent {
                Text("Check \(email) for a reset link. It can take a few minutes to arrive.").font(HHFont.body).foregroundStyle(HH.ink)
                HHButton(title: "Back to sign in", action: onDone)
            } else {
                HHTextField(label: "Email", text: $email, keyboard: .emailAddress).textInputAutocapitalization(.never)
                if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                HHButton(title: "Send reset link", loading: busy) {
                    guard !email.isEmpty else { error = "Enter the email you signed up with."; return }
                    busy = true
                    Task { do { try await Auth.auth().sendPasswordReset(withEmail: email); sent = true } catch { self.error = friendlyAuthError(error) }; busy = false }
                }
            }
        }
    }
}
