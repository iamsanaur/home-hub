import XCTest
@testable import HomeHub

/// Held to the same fixtures as Android's StatementParserTest (shared/statement-fixtures/fixtures.json).
final class StatementParserTests: XCTestCase {
    private func fixtures() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "fixtures", withExtension: "json"), "fixtures.json missing from the test bundle")
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    func testEveryFixtureReadsExactly() throws {
        let root = try fixtures()
        let zone = try XCTUnwrap(TimeZone(identifier: root["zone"] as? String ?? "Asia/Kolkata"))
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"] as! String
            let got = StatementParser.parse(c["lines"] as! [String], zone: zone)
            XCTAssertEqual(got.app.rawValue, c["app"] as? String, "\(name): app")
            XCTAssertEqual(got.skipped, c["skipped"] as? Int, "\(name): skipped")
            let want = c["rows"] as! [[String: Any]]
            XCTAssertEqual(got.rows.count, want.count, "\(name): row count")
            for (i, w) in want.enumerated() where i < got.rows.count {
                let g = got.rows[i]
                XCTAssertEqual(g.occurredAt, w["occurredAt"] as? String, "\(name)[\(i)] occurredAt")
                XCTAssertEqual(g.timeKnown, w["timeKnown"] as? Bool, "\(name)[\(i)] timeKnown")
                XCTAssertEqual(g.amountMinor, (w["amountMinor"] as? NSNumber)?.int64Value, "\(name)[\(i)] amount")
                XCTAssertEqual(g.direction, w["direction"] as? String, "\(name)[\(i)] direction")
                XCTAssertEqual(g.merchant, w["merchant"] as? String, "\(name)[\(i)] merchant")
                XCTAssertEqual(g.upiRef, w["upiRef"] as? String, "\(name)[\(i)] upiRef")
                XCTAssertEqual(g.accountLast4, w["accountLast4"] as? String, "\(name)[\(i)] accountLast4")
            }
        }
    }

    func testAmountsAreExactPaise() {
        XCTAssertEqual(StatementParser.minor("1,234.5"), 123450)
        XCTAssertEqual(StatementParser.minor("0.07"), 7)
        XCTAssertEqual(StatementParser.minor("299"), 29900)
    }
}
