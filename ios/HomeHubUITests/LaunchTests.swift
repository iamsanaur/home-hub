import XCTest

/// Launches against the local Firebase emulators and captures screenshots for design review.
final class LaunchTests: XCTestCase {
    func testWelcomeAndSignIn() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["HomeHub AI"].waitForExistence(timeout: 20) || app.buttons["Manage"].firstMatch.waitForExistence(timeout: 10))
        attach(app, "welcome")
        if app.buttons["Sign in"].exists {
            app.buttons["Sign in"].tap()
            let email = app.textFields["Email"]; XCTAssertTrue(email.waitForExistence(timeout: 5))
            email.tap(); email.typeText("owner@homehub.test")
            let pw = app.secureTextFields["Password"]; pw.tap(); pw.typeText("homehub-demo-1")
            app.buttons["Sign in"].firstMatch.tap()
        }
        XCTAssertTrue(app.buttons["Manage"].firstMatch.waitForExistence(timeout: 30))
        // The system may offer to save the password; dismiss it so it doesn't cover the dashboard.
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 4) { notNow.tap() }
        sleep(3); attach(app, "home")
        app.buttons["Manage"].firstMatch.tap(); sleep(2); attach(app, "manage")
        app.buttons["AI"].firstMatch.tap(); sleep(2); attach(app, "ai")
        app.buttons["Insights"].firstMatch.tap(); sleep(4); attach(app, "insights")
    }
    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
