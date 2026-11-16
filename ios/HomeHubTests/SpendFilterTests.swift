import XCTest
@testable import HomeHub

/// Must agree with Android's SpendFilterTest: only completed payments may leave the phone.
final class SpendFilterTests: XCTestCase {
    func testSendsCompletedPayments() {
        for t in ["Rs.450.00 debited from A/c XX1234 on 16-11-26 to VPA swiggy@icici (UPI Ref No 432112345678)",
                  "Paid ₹299 to Zomato", "₹1,250 paid to Blinkit", "INR 999.00 spent on ICICI Bank Card XX4321 at NETFLIX",
                  "Rs 50,000.00 credited to A/c XX9012 by NEFT from ACME PVT LTD"] {
            XCTAssertTrue(SpendCaptureSettings.looksLikePayment(t), t)
        }
    }
    func testKeepsEverythingElseOnThePhone() {
        for t in ["Your OTP for txn of Rs 500 is 123456. Do not share.", "Rs 2,000 will be debited on 20-11-26 for your SIP mandate",
                  "Your credit card bill of Rs 5,000 is due on 20-Nov", "Ravi has requested money Rs 500 from you on Google Pay",
                  "Mum: dinner at 8? I paid for the tickets", "Avl Bal in A/c XX1234 is Rs 10,000.00", "Hi"] {
            XCTAssertFalse(SpendCaptureSettings.looksLikePayment(t), t)
        }
    }
}
