package com.e404.homehub

import com.e404.homehub.spend.StatementParser
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.ZoneId

/** Both platforms' statement readers are held to the same fixtures in shared/statement-fixtures. */
class StatementParserTest {
    private val root = Json.parseToJsonElement(File("../../shared/statement-fixtures/fixtures.json").readText()).jsonObject
    private val zone = ZoneId.of(root["zone"]!!.jsonPrimitive.content)

    private fun str(o: JsonObject, k: String) = o[k]?.takeIf { it.toString() != "null" }?.jsonPrimitive?.content

    @Test fun everyFixtureReadsExactly() {
        val cases = root["cases"]!!.jsonArray
        assertTrue("fixtures should load", cases.isNotEmpty())
        for (c in cases) {
            val o = c.jsonObject
            val name = o["name"]!!.jsonPrimitive.content
            val got = StatementParser.parse(o["lines"]!!.jsonArray.map { it.jsonPrimitive.content }, zone)
            assertEquals("$name: app", o["app"]!!.jsonPrimitive.content, got.app.wire)
            assertEquals("$name: skipped", o["skipped"]!!.jsonPrimitive.int, got.skipped)
            val want: JsonArray = o["rows"]!!.jsonArray
            assertEquals("$name: row count", want.size, got.rows.size)
            want.forEachIndexed { i, w ->
                val r = w.jsonObject; val g = got.rows[i]
                assertEquals("$name[$i] occurredAt", str(r, "occurredAt"), g.occurredAt)
                assertEquals("$name[$i] timeKnown", r["timeKnown"]!!.jsonPrimitive.boolean, g.timeKnown)
                assertEquals("$name[$i] amount", r["amountMinor"]!!.jsonPrimitive.content.toLong(), g.amountMinor)
                assertEquals("$name[$i] direction", str(r, "direction"), g.direction)
                assertEquals("$name[$i] merchant", str(r, "merchant"), g.merchant)
                assertEquals("$name[$i] upiRef", str(r, "upiRef"), g.upiRef)
                assertEquals("$name[$i] accountLast4", str(r, "accountLast4"), g.accountLast4)
            }
        }
    }

    @Test fun amountsAreExactPaise() {
        assertEquals(123450L, StatementParser.minor("1,234.5"))
        assertEquals(7L, StatementParser.minor("0.07"))
        assertEquals(29900L, StatementParser.minor("299"))
    }
}
