import XCTest

/// Runs against the real Firebase project (scripts/use-firebase.sh prod). Skipped unless credentials
/// are supplied through the test runner environment — they never live in source:
///   TEST_RUNNER_HH_EMAIL=… TEST_RUNNER_HH_PASSWORD=… xcodebuild test -only-testing:HomeHubUITests/ProductionSmokeTests
final class ProductionSmokeTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testProductionSignInNotificationsAndAssistant() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["HH_EMAIL"], let password = env["HH_PASSWORD"] else { throw XCTSkip("No production test credentials supplied") }
        let app = XCUIApplication()
        app.launch()

        // Sign in (or reuse an existing session).
        XCTAssertTrue(app.staticTexts["HomeHub AI"].waitForExistence(timeout: 20) || app.buttons["Manage"].firstMatch.waitForExistence(timeout: 10))
        if app.buttons["Sign in"].exists {
            app.buttons["Sign in"].tap()
            let field = app.textFields["Email"]; XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap(); field.typeText(email)
            let pw = app.secureTextFields["Password"]; pw.tap(); pw.typeText(password)
            app.buttons["Sign in"].firstMatch.tap()
        }
        XCTAssertTrue(app.buttons["Manage"].firstMatch.waitForExistence(timeout: 40), "Didn't reach the dashboard")
        let notNow = app.buttons["Not Now"]; if notNow.waitForExistence(timeout: 4) { notNow.tap() }
        sleep(3); attach(app, "prod-home")

        // Notifications: contextual card → system dialog → Allow.
        let turnOn = app.buttons["Turn on"]
        if turnOn.waitForExistence(timeout: 8) {
            attach(app, "prod-notification-card")
            turnOn.tap()
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let allow = springboard.buttons["Allow"]
            XCTAssertTrue(allow.waitForExistence(timeout: 10), "System notification dialog didn't appear")
            allow.tap()
            XCTAssertTrue(turnOn.waitForNonExistence(timeout: 10), "Card should disappear once notifications are on")
        }

        // Assistant: a question only the model can answer, running on the phone against the live model.
        app.buttons["AI"].firstMatch.tap()
        let composer = app.textFields["Ask HomeHub…"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText("What should our household prioritise this week? Answer in two short sentences.")
        app.buttons["Send"].tap()
        let done = NSPredicate(format: "label CONTAINS[c] 'Completed' OR label CONTAINS[c] 'Verified' OR label CONTAINS[c] 'Failed' OR label CONTAINS[c] 'model'")
        XCTAssertTrue(app.staticTexts.containing(done).firstMatch.waitForExistence(timeout: 90), "Assistant run didn't finish")
        sleep(2); attach(app, "prod-assistant")

        // Connections reads the live gateway.
        app.buttons["Manage"].firstMatch.tap()
        let connections = app.staticTexts["Integrations, AI model, Alexa, activity and privacy"]
        for _ in 0..<6 where !(connections.exists && connections.isHittable) { app.swipeUp() }
        connections.tap()
        XCTAssertTrue(app.staticTexts["Assistant on this phone"].waitForExistence(timeout: 20))
        sleep(1); attach(app, "prod-connections")
    }

    /// Finance → "to review" card → confirm one captured payment (seeded through the API beforehand).
    func testSpendReviewConfirm() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["HH_EMAIL"], let password = env["HH_PASSWORD"] else { throw XCTSkip("No production test credentials supplied") }
        let app = XCUIApplication()
        app.launch()
        if app.buttons["Sign in"].waitForExistence(timeout: 10) {
            app.buttons["Sign in"].tap()
            let field = app.textFields["Email"]; XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap(); field.typeText(email)
            let pw = app.secureTextFields["Password"]; pw.tap(); pw.typeText(password)
            app.buttons["Sign in"].firstMatch.tap()
        }
        XCTAssertTrue(app.buttons["Manage"].firstMatch.waitForExistence(timeout: 40))
        let notNow = app.buttons["Not Now"]; if notNow.waitForExistence(timeout: 3) { notNow.tap() }
        app.buttons["Manage"].firstMatch.tap()
        let finance = app.staticTexts["Spending, income and budgets"]
        for _ in 0..<6 where !(finance.exists && finance.isHittable) { app.swipeUp() }
        finance.tap()
        let card = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'to review'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "No 'to review' card on Finance")
        attach(app, "spend-finance-card")
        card.tap()
        XCTAssertTrue(app.staticTexts["Uber India"].waitForExistence(timeout: 20), "Captured payment not listed")
        attach(app, "spend-review")
        app.buttons["Add expense"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Nothing to review"].waitForExistence(timeout: 20), "Confirm didn't clear the item")
        attach(app, "spend-review-done")
    }

    /// Screenshots of the five primary tabs, for Android/iOS visual parity reviews.
    func testCapturePrimaryTabs() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["HH_EMAIL"], let password = env["HH_PASSWORD"] else { throw XCTSkip("No production test credentials supplied") }
        let app = XCUIApplication()
        app.launch()
        if app.buttons["Sign in"].waitForExistence(timeout: 10) {
            app.buttons["Sign in"].tap()
            let field = app.textFields["Email"]; XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap(); field.typeText(email)
            let pw = app.secureTextFields["Password"]; pw.tap(); pw.typeText(password)
            app.buttons["Sign in"].firstMatch.tap()
        }
        XCTAssertTrue(app.buttons["Manage"].firstMatch.waitForExistence(timeout: 40))
        let notNow = app.buttons["Not Now"]; if notNow.waitForExistence(timeout: 3) { notNow.tap() }
        for tab in ["Home", "Manage", "AI", "Family", "Insights"] {
            app.buttons[tab].firstMatch.tap(); sleep(3); attach(app, "tab-\(tab)")
        }
        // Secondary screens reached from Manage (subtitle text identifies each row).
        for (row, name) in [("Chores, errands and reminders", "Tasks"), ("What to buy, by category", "Shopping"), ("Spending, income and budgets", "Finance"), ("Integrations, AI model, Alexa, activity and privacy", "Connections")] {
            app.buttons["Manage"].firstMatch.tap(); sleep(1)
            let r = app.staticTexts[row]
            for _ in 0..<6 where !(r.exists && r.isHittable) { app.swipeUp() }
            r.tap(); sleep(3); attach(app, "tab-\(name)")
            app.navigationBars.buttons.firstMatch.tap(); sleep(1)
            for _ in 0..<3 { app.swipeDown() }
        }
        app.buttons["Home"].firstMatch.tap(); sleep(1)
        app.buttons["Settings"].firstMatch.tap(); sleep(3); attach(app, "tab-Settings")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
