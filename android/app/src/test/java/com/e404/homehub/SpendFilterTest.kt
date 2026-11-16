package com.e404.homehub

import com.e404.homehub.spend.SpendCapture
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The on-device filter decides what may leave the phone; anything that isn't a completed payment must stay. */
class SpendFilterTest {
    @Test fun sendsCompletedPayments() {
        listOf(
            "Rs.450.00 debited from A/c XX1234 on 16-11-26 to VPA swiggy@icici (UPI Ref No 432112345678)",
            "Paid ₹299 to Zomato",
            "₹1,250 paid to Blinkit",
            "INR 999.00 spent on ICICI Bank Card XX4321 at NETFLIX",
            "Rs 50,000.00 credited to A/c XX9012 by NEFT from ACME PVT LTD",
        ).forEach { assertTrue(it, SpendCapture.looksLikePayment(it)) }
    }

    @Test fun keepsEverythingElseOnThePhone() {
        listOf(
            "Your OTP for txn of Rs 500 is 123456. Do not share.",
            "Rs 2,000 will be debited on 20-11-26 for your SIP mandate",
            "Your credit card bill of Rs 5,000 is due on 20-Nov",
            "Ravi has requested money Rs 500 from you on Google Pay",
            "Mum: dinner at 8? I paid for the tickets",       // no amount
            "Avl Bal in A/c XX1234 is Rs 10,000.00",            // no payment verb
            "Hi",
        ).forEach { assertFalse(it, SpendCapture.looksLikePayment(it)) }
    }
}
