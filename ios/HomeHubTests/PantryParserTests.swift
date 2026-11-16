import XCTest
@testable import HomeHub

/// The same cases run in the Android app (PantryParserTest.kt) so both read lists identically.
final class PantryParserTests: XCTestCase {
    private func check(_ s: String, _ name: String, _ qty: Double, _ unit: String, file: StaticString = #filePath, line: UInt = #line) {
        let r = PantryParser.parseLine(s)
        XCTAssertNil(r.problem, s, file: file, line: line)
        XCTAssertEqual(r.name, name, "name of '\(s)'", file: file, line: line)
        XCTAssertEqual(r.quantity, qty, accuracy: 0.0001, "qty of '\(s)'", file: file, line: line)
        XCTAssertEqual(r.unit, unit, "unit of '\(s)'", file: file, line: line)
    }
    func testQuantityFirst() { check("2 kg rice", "Rice", 2, "kg"); check("500g atta", "Atta", 500, "g"); check("1.5 l milk", "Milk", 1.5, "l"); check("2 packets noodles", "Noodles", 2, "pack") }
    func testQuantityLast() { check("rice 2kg", "Rice", 2, "kg"); check("rice - 2 kg", "Rice", 2, "kg"); check("Tur dal, 1, kg", "Tur dal", 1, "kg"); check("milk (2 l)", "Milk", 2, "l") }
    func testCounts() { check("eggs x12", "Eggs", 12, "pcs"); check("12 eggs", "Eggs", 12, "pcs"); check("2 dozen bananas", "Bananas", 2, "dozen"); check("3 x tomatoes", "Tomatoes", 3, "pcs"); check("2 bunches coriander", "Coriander", 2, "bunch") }
    func testFractionsAndCommas() { check("½ kg sugar", "Sugar", 0.5, "kg"); check("1/2 kg sugar", "Sugar", 0.5, "kg"); check("1,5 l oil", "Oil", 1.5, "l"); check("1,000 g flour", "Flour", 1000, "g") }
    func testNoQuantityMeansOne() { check("salt", "Salt", 1, "pcs"); check("- turmeric powder", "Turmeric powder", 1, "pcs"); check("• ghee", "Ghee", 1, "pcs") }
    func testBulletsAndNumbering() { check("1. rice 2 kg", "Rice", 2, "kg"); check("* 2 kg onions", "Onions", 2, "kg"); check("2 kg rice", "Rice", 2, "kg") }
    func testPastedBlock() {
        let r = PantryParser.parse("# groceries\n2 kg rice\n\nmilk 2 l; eggs x12\n- salt")
        XCTAssertEqual(r.map(\.name), ["Rice", "Milk", "Eggs", "Salt"]); XCTAssertEqual(r.filter { $0.problem != nil }.count, 0)
    }
    func testProblemsAreReported() {
        XCTAssertNotNil(PantryParser.parseLine("2 kg").problem); XCTAssertNotNil(PantryParser.parseLine("---").problem)
        XCTAssertNotNil(PantryParser.parseLine("0 kg rice").problem); XCTAssertNotNil(PantryParser.parseLine("99999999 kg rice").problem)
    }
    func testDuplicatesMerged() {
        let m = PantryParser.mergeDuplicates(PantryParser.parse("rice 1 kg\nRice 2 kg\nrice 500 g"))
        XCTAssertEqual(m.count, 2); XCTAssertEqual(m.first { $0.unit == "kg" }!.quantity, 3, accuracy: 0.0001)
    }
    func testLimit() { XCTAssertEqual(PantryParser.parse((1...300).map { "item\($0)" }.joined(separator: "\n")).count, PantryParser.maxItems + 1) }
}
