package com.e404.homehub

import com.e404.homehub.data.model.Money
import com.e404.homehub.data.sync.ConflictPolicy
import com.e404.homehub.data.sync.SyncDecision
import com.e404.homehub.ui.util.Dates
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

class DataLayerTest {
    @Test fun `money parses exactly and never uses floating point`() {
        assertEquals(123450L, Money.parse("1,234.50", "INR"))
        assertEquals(10L, Money.parse("0.1", "USD"))
        assertEquals(1500L, Money.parse("1500", "JPY"))
        assertNull(Money.parse("1.234", "INR"))
        assertNull(Money.parse("abc", "INR"))
        assertEquals("₹1,234.50", Money.format(123450, "INR", Locale.forLanguageTag("en-IN")))
        assertEquals(85, Money.percent(8500, 10000))
        assertEquals("1234.50", Money.toInput(123450, "INR"))
    }

    @Test fun `conflict policy merges completion and purchase, rejects other concurrent edits`() {
        assertEquals(SyncDecision.Apply, ConflictPolicy.decideUpdate("tasks", 3, true, 3, setOf("title"), emptyMap()))
        assertEquals(SyncDecision.Apply, ConflictPolicy.decideUpdate("tasks", 3, true, 5, setOf("status", "completedAt", "completedBy"), mapOf("status" to "open")))
        assertEquals(SyncDecision.AlreadyApplied, ConflictPolicy.decideUpdate("tasks", 3, true, 5, setOf("status", "completedAt", "completedBy"), mapOf("status" to "done")))
        assertTrue(ConflictPolicy.decideUpdate("tasks", 3, true, 5, setOf("title"), mapOf("status" to "open")) is SyncDecision.Conflict)
        assertEquals(SyncDecision.Apply, ConflictPolicy.decideUpdate("groceryItems", 1, true, 2, setOf("purchased", "purchasedAt", "purchasedBy"), mapOf("purchased" to false)))
        assertTrue(ConflictPolicy.decideUpdate("notes", 1, true, 2, setOf("body"), emptyMap()) is SyncDecision.Conflict)
        assertTrue(ConflictPolicy.decideUpdate("tasks", 1, false, 0, setOf("title"), emptyMap()) is SyncDecision.Conflict)
        assertEquals(SyncDecision.AlreadyApplied, ConflictPolicy.decideCreate(true, "op1", "op1"))
        assertTrue(ConflictPolicy.decideCreate(true, "other", "op1") is SyncDecision.Conflict)
        assertEquals(30L, ConflictPolicy.backoffSeconds(1))
        assertEquals(6 * 3600L, ConflictPolicy.backoffSeconds(50))
    }

    @Test fun `dates format in the household time zone`() {
        val zone = ZoneId.of("Asia/Kolkata")
        val now = Instant.parse("2026-11-16T06:00:00Z") // 11:30 IST
        assertTrue(Dates.relative(Instant.parse("2026-11-16T12:30:00Z"), zone, now, Locale.UK).startsWith("Today"))
        assertTrue(Dates.relative(Instant.parse("2026-11-17T04:30:00Z"), zone, now, Locale.UK).startsWith("Tomorrow"))
        assertEquals("0.3", Dates.qty(0.3))
        assertEquals("2", Dates.qty(2.0))
        assertEquals("Good morning", Dates.greeting(now, zone))
    }
}
