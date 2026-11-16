import { describe, expect, it } from "vitest";
import { parseBankMessage, toMinor } from "../../src/finance/spendCapture";

describe("spend capture parser (Indian bank / UPI messages)", () => {
  it("converts amounts to paise without floating point", () => {
    expect(toMinor("1,234.5")).toBe(123450);
    expect(toMinor("299")).toBe(29900);
    expect(toMinor("0.07")).toBe(7);
  });

  const cases: Array<[string, Partial<ReturnType<typeof parseBankMessage>> | null]> = [
    ["Rs.450.00 debited from A/c XX1234 on 16-11-26 to VPA swiggy@icici (UPI Ref No 432112345678). Not you? Call 18002586161",
      { amountMinor: 45000, direction: "debit", merchant: "Swiggy", upiRef: "432112345678", accountLast4: "1234", method: "upi" }],
    ["₹1,250 paid to Blinkit", { amountMinor: 125000, direction: "debit", merchant: "Blinkit" }],
    ["Paid ₹299 to Zomato", { amountMinor: 29900, direction: "debit", merchant: "Zomato" }],
    ["Spent Rs.2,499.00 On HDFC Bank Card 5678 At AMAZON PAY INDIA On 2026-11-16:10:12:00",
      { amountMinor: 249900, direction: "debit", merchant: "Amazon Pay India", accountLast4: "5678", method: "card" }],
    ["Rs 50,000.00 credited to A/c XX9012 on 01-11-26 by NEFT from ACME PVT LTD",
      { amountMinor: 5000000, direction: "credit", accountLast4: "9012", method: "bank_transfer" }],
    ["Sent Rs.120.00 From HDFC Bank A/C *1234 To RAPIDO On 16/11/26 Ref 432198765432",
      { amountMinor: 12000, direction: "debit", merchant: "Rapido", upiRef: "432198765432" }],
    ["INR 999.00 spent on ICICI Bank Card XX4321 on 16-Nov-26 at NETFLIX. Avl Lmt: INR 1,00,000",
      { amountMinor: 99900, direction: "debit", merchant: "Netflix", accountLast4: "4321", method: "card" }],
    // Not completed payments → ignored.
    ["Your OTP for txn of Rs 500 is 123456. Do not share.", null],
    ["Avl Bal in A/c XX1234 is Rs 10,000.00 as on 16-11-26", null],
    ["Your credit card bill of Rs 5,000 is due on 20-Nov", null],
    ["Payment of Rs 100 to Rapido failed. Amount will be refunded if debited.", null],
    ["Rs 2,000 will be debited on 20-11-26 for your SIP mandate", null],
    ["Ravi has requested money Rs 500 from you on Google Pay", null],
    ["Hello! Your parcel is out for delivery.", null],
  ];
  for (const [text, want] of cases) {
    it(want ? `parses: ${text.slice(0, 48)}…` : `ignores: ${text.slice(0, 48)}…`, () => {
      const got = parseBankMessage(text);
      if (want === null) expect(got).toBeNull();
      else expect(got).toMatchObject(want);
    });
  }
});
