package com.e404.homehub

import com.e404.homehub.ui.util.PantryParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The same cases run in the iOS app (PantryParserTests.swift) so both read lists identically. */
class PantryParserTest {
    private fun one(s: String) = PantryParser.parseLine(s)
    private fun check(s: String, name: String, qty: Double, unit: String) {
        val r = one(s)
        assertNull("$s -> ${r.problem}", r.problem)
        assertEquals("name of '$s'", name, r.name); assertEquals("qty of '$s'", qty, r.quantity, 0.0001); assertEquals("unit of '$s'", unit, r.unit)
    }

    @Test fun quantityFirst() { check("2 kg rice", "Rice", 2.0, "kg"); check("500g atta", "Atta", 500.0, "g"); check("1.5 l milk", "Milk", 1.5, "l"); check("2 packets noodles", "Noodles", 2.0, "pack") }
    @Test fun quantityLast() { check("rice 2kg", "Rice", 2.0, "kg"); check("rice - 2 kg", "Rice", 2.0, "kg"); check("Tur dal, 1, kg", "Tur dal", 1.0, "kg"); check("milk (2 l)", "Milk", 2.0, "l") }
    @Test fun countsAndMultipliers() { check("eggs x12", "Eggs", 12.0, "pcs"); check("12 eggs", "Eggs", 12.0, "pcs"); check("2 dozen bananas", "Bananas", 2.0, "dozen"); check("3 x tomatoes", "Tomatoes", 3.0, "pcs"); check("2 bunches coriander", "Coriander", 2.0, "bunch") }
    @Test fun fractionsAndCommas() { check("½ kg sugar", "Sugar", 0.5, "kg"); check("1/2 kg sugar", "Sugar", 0.5, "kg"); check("1,5 l oil", "Oil", 1.5, "l"); check("1,000 g flour", "Flour", 1000.0, "g") }
    @Test fun noQuantityMeansOne() { check("salt", "Salt", 1.0, "pcs"); check("- turmeric powder", "Turmeric powder", 1.0, "pcs"); check("• ghee", "Ghee", 1.0, "pcs") }
    @Test fun bulletsAndNumbering() { check("1. rice 2 kg", "Rice", 2.0, "kg"); check("* 2 kg onions", "Onions", 2.0, "kg"); check("2 kg rice", "Rice", 2.0, "kg") /* a leading quantity is not numbering */ }

    @Test fun pastedBlock() {
        val r = PantryParser.parse("# groceries\n2 kg rice\n\nmilk 2 l; eggs x12\n- salt")
        assertEquals(listOf("Rice", "Milk", "Eggs", "Salt"), r.map { it.name })
        assertEquals(0, r.count { it.problem != null })
    }

    @Test fun problemsAreReportedNotGuessed() {
        assertNotNull(one("2 kg").problem)   // a quantity with no item
        assertNotNull(one("---").problem)
        assertNotNull(one("0 kg rice").problem)
        assertNotNull(one("99999999 kg rice").problem)
    }

    @Test fun duplicatesAreMerged() {
        val merged = PantryParser.mergeDuplicates(PantryParser.parse("rice 1 kg\nRice 2 kg\nrice 500 g"))
        assertEquals(2, merged.size)
        assertEquals(3.0, merged.first { it.unit == "kg" }.quantity, 0.0001)
    }

    @Test fun limitsHowManyLinesAreRead() { assertEquals(PantryParser.MAX_ITEMS + 1, PantryParser.parse((1..300).joinToString("\n") { "item$it" }).size) }
}
