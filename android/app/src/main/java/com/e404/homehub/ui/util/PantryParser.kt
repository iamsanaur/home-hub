package com.e404.homehub.ui.util

/** One line of a pasted pantry list, read into an item. [problem] is set when the line couldn't be read. */
data class ParsedPantryLine(val raw: String, val name: String, val quantity: Double, val unit: String, val problem: String?)

/**
 * Reads a pasted shopping/pantry list on the phone (no AI, no network): one item per line (or separated by ";").
 * Understands "2 kg rice", "rice 2kg", "rice - 2 kg", "rice, 2 kg", "eggs x12", "milk 1.5 l", "½ kg sugar",
 * "- salt" (quantity 1), bullets and numbering. Units map onto HomeHub's list: pcs, kg, g, l, ml, pack, dozen, bunch.
 * The same rules and test lines exist in the iOS app (PantryParser.swift).
 */
object PantryParser {
    const val MAX_ITEMS = 100
    val UNITS = listOf("pcs", "kg", "g", "l", "ml", "pack", "dozen", "bunch")

    private val UNIT_WORDS = mapOf(
        "kg" to "kg", "kgs" to "kg", "kilo" to "kg", "kilos" to "kg", "kilogram" to "kg", "kilograms" to "kg",
        "g" to "g", "gm" to "g", "gms" to "g", "gram" to "g", "grams" to "g", "gr" to "g",
        "l" to "l", "lt" to "l", "ltr" to "l", "ltrs" to "l", "litre" to "l", "litres" to "l", "liter" to "l", "liters" to "l",
        "ml" to "ml", "millilitre" to "ml", "milliliter" to "ml", "millilitres" to "ml", "milliliters" to "ml",
        "pc" to "pcs", "pcs" to "pcs", "piece" to "pcs", "pieces" to "pcs", "no" to "pcs", "nos" to "pcs", "unit" to "pcs", "units" to "pcs",
        "bottle" to "pcs", "bottles" to "pcs", "can" to "pcs", "cans" to "pcs", "tin" to "pcs", "tins" to "pcs", "box" to "pcs", "boxes" to "pcs",
        "pack" to "pack", "packs" to "pack", "packet" to "pack", "packets" to "pack", "pkt" to "pack", "pkts" to "pack",
        "dozen" to "dozen", "doz" to "dozen", "dz" to "dozen",
        "bunch" to "bunch", "bunches" to "bunch",
    )
    private val UNIT_ALT = UNIT_WORDS.keys.sortedByDescending { it.length }.joinToString("|")
    private const val NUM = """(?:\d+\s*/\s*\d+|\d+(?:[.,]\d+)?|[½¼¾])"""
    private val START = Regex("""^($NUM)\s*($UNIT_ALT)?\b\.?\s*(?:of\s+|x\s+|×\s*)?(.+)$""", RegexOption.IGNORE_CASE)
    private val END = Regex("""^(.+?)[\s,:\-–—|]*\(?(?:x\s*|×\s*)?($NUM)[\s,]*($UNIT_ALT)?\)?$""", RegexOption.IGNORE_CASE)
    private val ONLY_QUANTITY = Regex("""^($NUM)\s*($UNIT_ALT)?\.?$""", RegexOption.IGNORE_CASE)
    private val BULLET = Regex("""^\s*(?:[-*•·–—]+|\d+[.)](?=\s+\D))\s*""")

    private fun number(s: String): Double? {
        val t = s.trim()
        return when {
            t == "½" -> 0.5; t == "¼" -> 0.25; t == "¾" -> 0.75
            t.contains('/') -> t.split('/').let { p -> (p[0].trim().toDoubleOrNull() ?: return null) / (p[1].trim().toDoubleOrNull()?.takeIf { it != 0.0 } ?: return null) }
            // "1,5" is 1.5; "1,000" is a thousand.
            Regex("""^\d+,\d{3}$""").matches(t) -> t.replace(",", "").toDouble()
            else -> t.replace(',', '.').toDoubleOrNull()
        }
    }

    private fun tidy(name: String): String {
        val n = name.replace(Regex("""\s+"""), " ").trim().trim(',', ':', ';', '-', '–', '—', '|', '.', '(', ')').trim()
        return if (n.isEmpty()) n else n.replaceFirstChar { it.uppercase() }
    }

    fun parse(text: String): List<ParsedPantryLine> =
        text.split('\n', ';').map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.take(MAX_ITEMS + 1).map { parseLine(it) }

    fun parseLine(raw: String): ParsedPantryLine {
        val line = raw.replace(BULLET, "").trim()
        if (ONLY_QUANTITY.matches(line)) return ParsedPantryLine(raw, "", 1.0, "pcs", "No item name")
        START.matchEntire(line)?.let { m -> return build(raw, m.groupValues[3], m.groupValues[1], m.groupValues[2]) }
        END.matchEntire(line)?.let { m -> return build(raw, m.groupValues[1], m.groupValues[2], m.groupValues[3]) }
        return build(raw, line, null, "")
    }

    private fun build(raw: String, rawName: String, qtyText: String?, unitText: String): ParsedPantryLine {
        val name = tidy(rawName)
        val qty = qtyText?.let { number(it) } ?: 1.0
        val unit = UNIT_WORDS[unitText.lowercase()] ?: "pcs"
        val problem = when {
            name.isEmpty() || name.all { !it.isLetter() } -> "No item name"
            name.length > 60 -> "Name is too long"
            qty <= 0 -> "Quantity must be more than zero"
            qty > 100_000 -> "Quantity is too large"
            else -> null
        }
        return ParsedPantryLine(raw, name, qty, unit, problem)
    }

    /** Same item written twice in the paste ("rice 1 kg" + "rice 2 kg") becomes one line with the quantities added. */
    fun mergeDuplicates(lines: List<ParsedPantryLine>): List<ParsedPantryLine> {
        val out = LinkedHashMap<String, ParsedPantryLine>()
        for (l in lines) {
            if (l.problem != null) { out["bad:${out.size}:${l.raw}"] = l; continue }
            val k = "${l.name.lowercase()}|${l.unit}"
            out[k] = out[k]?.let { it.copy(quantity = it.quantity + l.quantity) } ?: l
        }
        return out.values.toList()
    }
}
