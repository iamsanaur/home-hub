import XCTest

/// Drives the Connections area against the local Firebase emulators (seeded owner account):
/// connect the simulated device plugin, switch a lamp and read back the verified state,
/// then open the automations, channels, agents, activity and privacy screens.
final class ConnectionsTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testConnectionsFlow() throws {
        let app = XCUIApplication()
        app.launch()
        signInIfNeeded(app)

        app.buttons["Manage"].firstMatch.tap()
        let connections = app.staticTexts["Integrations, AI model, Alexa, activity and privacy"]
        for _ in 0..<6 where !(connections.exists && connections.isHittable) { app.swipeUp() }
        connections.tap()
        XCTAssertTrue(app.staticTexts["Assistant on this phone"].waitForExistence(timeout: 20), "Gateway status didn't load")
        attach(app, "connections")

        // Integrations → connect the simulated devices (once per seeded household).
        tapRow(app, "Connect services and devices")
        XCTAssertTrue(app.staticTexts["Catalog"].waitForExistence(timeout: 20))
        attach(app, "integrations")
        let demo = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Demo devices'")).firstMatch
        if demo.waitForExistence(timeout: 5), !app.staticTexts["Connected"].exists {
            demo.tap()
            let consent = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'I allow'")).firstMatch
            XCTAssertTrue(consent.waitForExistence(timeout: 5))
            for _ in 0..<4 where !consent.isHittable { app.swipeUp() }
            consent.switches.firstMatch.exists ? consent.switches.firstMatch.tap() : consent.tap()
            attach(app, "connect-sheet")
            app.buttons["Connect"].firstMatch.tap()
            XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 20), "Integration did not connect")
        }
        app.navigationBars.buttons.firstMatch.tap()

        // Devices → switch the lamp and wait for the device-verified result.
        tapRow(app, "Lights, plugs, AC, locks and sensors")
        let lamp = app.staticTexts["Living room lamp"].firstMatch
        XCTAssertTrue(lamp.waitForExistence(timeout: 20))
        attach(app, "devices")
        lamp.tap()
        let power = app.switches["Power"]
        XCTAssertTrue(power.waitForExistence(timeout: 5))
        let before = power.value as? String
        power.switches.firstMatch.exists ? power.switches.firstMatch.tap() : power.tap()
        XCTAssertTrue(app.staticTexts["Done. The device confirmed it."].waitForExistence(timeout: 20), "Device action wasn't verified")
        XCTAssertNotEqual(power.value as? String, before)
        attach(app, "device-sheet")
        app.buttons["Close"].tap()
        app.navigationBars.buttons.firstMatch.tap()

        for (row, marker) in [("When this happens, do that", "Automations"), ("Where you can reach HomeHub", "Amazon Alexa"), ("What the assistant can do", "Skills"), ("Every action, who did it and the result", "All"), ("What each connection can see and keep", "Your data")] {
            tapRow(app, row)
            XCTAssertTrue(app.descendants(matching: .any)[marker].firstMatch.waitForExistence(timeout: 20), "\(row) didn't load")
            sleep(1); attach(app, marker.lowercased().replacingOccurrences(of: " ", with: "-"))
            app.navigationBars.buttons.firstMatch.tap()
        }
    }

    private func tapRow(_ app: XCUIApplication, _ title: String) {
        let row = app.staticTexts[title].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "No row \(title)")
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        row.tap()
    }

    private func signInIfNeeded(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["HomeHub AI"].waitForExistence(timeout: 20) || app.buttons["Manage"].firstMatch.waitForExistence(timeout: 10))
        if app.buttons["Sign in"].exists {
            app.buttons["Sign in"].tap()
            let email = app.textFields["Email"]; XCTAssertTrue(email.waitForExistence(timeout: 5))
            email.tap(); email.typeText("owner@homehub.test")
            let pw = app.secureTextFields["Password"]; pw.tap(); pw.typeText("homehub-demo-1")
            app.buttons["Sign in"].firstMatch.tap()
        }
        XCTAssertTrue(app.buttons["Manage"].firstMatch.waitForExistence(timeout: 30))
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 4) { notNow.tap() }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
