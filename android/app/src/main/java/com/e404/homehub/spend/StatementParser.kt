package com.e404.homehub.spend

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Reads the text of a UPI-app or bank statement (PhonePe, Google Pay, Paytm, or a bank's PDF) into payment rows.
 *
 * Pure and offline: it gets the lines of text that PDF extraction produced and returns rows. Nothing here touches the
 * network or storage. Keep this in step with ios/HomeHub/Features/StatementParser.swift — both are tested against
 * shared/statement-fixtures/fixtures.json.
 *
 * Approach: a statement is a list of dated entries. Every line that starts with a date opens an entry, and the lines
 * after it (until the next date) belong to it. Money amounts, direction, merchant, UPI reference and time are then
 * picked out of the entry. Entries that aren't completed payments (failed, no amount) are dropped, and an entry whose
 * direction can't be established is skipped rather than guessed — money in vs out must never be a coin toss.
 */
enum class StatementApp(val wire: String, val label: String) {
    PHONEPE("phonepe", "PhonePe"), GPAY("gpay", "Google Pay"), PAYTM("paytm", "Paytm"), BANK("bank", "Bank statement"), OTHER("other", "Statement"),
}

data class StatementRow(
    val occurredAt: String, // ISO-8601 with offset
    val timeKnown: Boolean,
    val amountMinor: Long,
    val direction: String, // "debit" | "credit"
    val merchant: String?,
    val upiRef: String?,
    val accountLast4: String?,
    val method: String = "upi",
)

data class StatementParse(val app: StatementApp, val rows: List<StatementRow>, val skipped: Int)

object StatementParser {
    private val MONTHS = listOf("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")

    // Nov 17, 2026 · 17Nov, 2026 / 17 Nov 2026 / 17-Nov-26 · 17/11/26 / 17-11-2026
    private val DATE_A = Regex("""^\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})""")
    private val DATE_B = Regex("""^\s*(\d{1,2})(?:st|nd|rd|th)?[\s-]*([A-Za-z]{3,9})\.?,?[\s-]*(\d{2,4})""")
    private val DATE_C = Regex("""^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})""")
    private val TIME = Regex("""\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?""")
    private val AMOUNT = Regex("""([+-])?\s*(?:₹|\bRs\.?|\bINR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""", RegexOption.IGNORE_CASE)
    private val DECIMAL = Regex("""(?<![\d.,])\d{1,3}(?:,\d{2,3})*\.\d{2}(?![\d.])|(?<![\d.,])\d+\.\d{2}(?![\d.])""")
    private val REF_LABELLED = Regex("""(?:UTR(?:\s*No\.?)?|UPI\s*Ref(?:erence)?(?:\s*(?:No|Number)\.?)?|UPI\s*Transaction\s*ID|RRN)\s*[:#]?\s*(\d{12})\b""", RegexOption.IGNORE_CASE)
    private val REF_ANY = Regex("""\b(\d{12})\b""")
    private val ACCOUNT = Regex("""(?:Paid\s+(?:by|from)|Debited\s+from|Credited\s+to|Account|A/c)[^0-9\n]{0,40}(\d{4})\b""", RegexOption.IGNORE_CASE)
    private val FAILED = Regex("""\b(failed|declined|cancelled|canceled|pending|unsuccessful)\b""", RegexOption.IGNORE_CASE)
    private val EXPLICIT = Regex("""\b(DEBIT|CREDIT)\b""")
    private val DEBIT_WORDS = Regex("""\b(paid to|payment to|sent to|money sent|bill paid|paid for)\b""", RegexOption.IGNORE_CASE)
    private val CREDIT_WORDS = Regex("""\b(received from|money received|refund|cashback)\b""", RegexOption.IGNORE_CASE)
    private val MERCHANT = Regex(
        """(?:Paid to|Received from|Payment to|Sent to|Money sent to|Refund from)\s+([^\n]+?)(?=\s+(?:DEBIT|CREDIT)\b|\s*(?:₹|Rs\.?\s?\d|INR\s?\d)|\s+[+-]\s*(?:₹|Rs|INR)|\s+(?:Transaction\s+ID|UTR|UPI)\b|\n|$)""",
        RegexOption.IGNORE_CASE,
    )
    private val OPENING = Regex("""opening\s+balance\D{0,20}([0-9][0-9,]*\.\d{2})""", RegexOption.IGNORE_CASE)

    private class Entry(val date: LocalDate, val lines: MutableList<String>)

    fun parse(rawLines: List<String>, zone: ZoneId): StatementParse {
        val lines = rawLines.map { it.replace(Regex("""\s+"""), " ").trim() }.filter { it.isNotEmpty() }
        val head = lines.take(60).joinToString(" ")
        val declared = when {
            Regex("phonepe", RegexOption.IGNORE_CASE).containsMatchIn(head) -> StatementApp.PHONEPE
            Regex("google\\s*pay|gpay", RegexOption.IGNORE_CASE).containsMatchIn(head) -> StatementApp.GPAY
            Regex("paytm", RegexOption.IGNORE_CASE).containsMatchIn(head) -> StatementApp.PAYTM
            Regex("narration|particulars|withdrawal|description|debit", RegexOption.IGNORE_CASE).containsMatchIn(head) &&
                Regex("balance", RegexOption.IGNORE_CASE).containsMatchIn(head) -> StatementApp.BANK
            else -> StatementApp.OTHER
        }
        val entries = entries(lines)
        if (declared == StatementApp.BANK) return bank(entries, lines, zone)
        val rows = mutableListOf<StatementRow>(); var skipped = 0
        for (e in entries) {
            val text = e.lines.joinToString("\n")
            if (FAILED.containsMatchIn(text)) continue
            val amt = AMOUNT.find(text) ?: continue
            val dir = EXPLICIT.find(text)?.value?.let { if (it == "DEBIT") "debit" else "credit" }
                ?: amt.groupValues[1].takeIf { it.isNotEmpty() }?.let { if (it == "-") "debit" else "credit" }
                ?: run {
                    val d = DEBIT_WORDS.containsMatchIn(text); val c = CREDIT_WORDS.containsMatchIn(text)
                    if (d != c) (if (d) "debit" else "credit") else null
                }
            if (dir == null) { skipped++; continue }
            val minor = minor(amt.groupValues[2]) ?: continue
            if (minor <= 0) continue
            val time = TIME.find(text)?.let { clock(it) }
            rows += StatementRow(
                occurredAt = iso(e.date, time, zone), timeKnown = time != null, amountMinor = minor, direction = dir,
                merchant = MERCHANT.find(text)?.groupValues?.get(1)?.let(::tidy),
                upiRef = (REF_LABELLED.find(text) ?: REF_ANY.find(text))?.groupValues?.get(1),
                accountLast4 = ACCOUNT.find(text)?.groupValues?.get(1),
            )
        }
        val app = if (declared == StatementApp.OTHER && rows.isEmpty()) StatementApp.OTHER else declared
        return StatementParse(app, rows, skipped)
    }

    // ---- bank statements: direction comes from the running balance, because plain text loses the column ----

    private class Bank(val e: Entry, val amount: Long?, val balance: Long?, val upi: Boolean)

    private fun bank(entries: List<Entry>, all: List<String>, zone: ZoneId): StatementParse {
        val money = { s: String -> minor(s) }
        val items = entries.map { e ->
            val text = e.lines.joinToString(" ")
            val nums = DECIMAL.findAll(text).map { it.value }.toList()
            Bank(e, nums.getOrNull(nums.size - 2)?.let(money).takeIf { nums.size >= 2 }, nums.lastOrNull()?.let(money), Regex("""\bUPI\b""", RegexOption.IGNORE_CASE).containsMatchIn(text))
        }
        val opening = all.firstNotNullOfOrNull { OPENING.find(it)?.groupValues?.get(1)?.let(money) }
        val rows = mutableListOf<StatementRow>(); var skipped = 0
        items.forEachIndexed { i, b ->
            if (!b.upi || b.amount == null || b.amount <= 0) return@forEachIndexed
            val text = b.e.lines.joinToString(" ")
            // Balance before this entry is the neighbouring entry's balance; which neighbour depends on the sort order.
            val neighbours = listOfNotNull(items.getOrNull(i - 1)?.balance ?: if (i == 0) opening else null, items.getOrNull(i + 1)?.balance)
            var dir: String? = null
            if (b.balance != null) {
                val outs = neighbours.any { it - b.amount == b.balance }
                val ins = neighbours.any { it + b.amount == b.balance }
                if (outs != ins) dir = if (outs) "debit" else "credit"
            }
            if (dir == null) {
                val dr = Regex("""UPI[-/ ]DR\b|/DR/|\bDEBIT\b""", RegexOption.IGNORE_CASE).containsMatchIn(text)
                val cr = Regex("""UPI[-/ ]CR\b|/CR/|\bCREDIT\b""", RegexOption.IGNORE_CASE).containsMatchIn(text)
                if (dr != cr) dir = if (dr) "debit" else "credit"
            }
            if (dir == null) { skipped++; return@forEachIndexed }
            rows += StatementRow(
                occurredAt = iso(b.e.date, null, zone), timeKnown = false, amountMinor = b.amount, direction = dir,
                merchant = bankMerchant(text), upiRef = REF_ANY.find(text)?.groupValues?.get(1), accountLast4 = null,
            )
        }
        return StatementParse(StatementApp.BANK, rows, skipped)
    }

    private fun bankMerchant(text: String): String? {
        Regex("""UPI/(?:DR|CR)/\d{12}/([^/]+)/""", RegexOption.IGNORE_CASE).find(text)?.let { return tidy(it.groupValues[1]) }   // SBI
        Regex("""UPI-([^-]+)-[^-\s]*@[^-\s]*-""", RegexOption.IGNORE_CASE).find(text)?.let { return tidy(it.groupValues[1]) }      // HDFC
        Regex("""UPI/([A-Za-z][^/]*)/\d{12}""", RegexOption.IGNORE_CASE).find(text)?.let { return tidy(it.groupValues[1]) }         // Kotak
        Regex("""([\w.\-]+)@[A-Za-z]+""").find(text)?.let { return tidy(it.groupValues[1]) }
        return null
    }

    // ---- shared helpers ----

    private fun entries(lines: List<String>): List<Entry> {
        val out = mutableListOf<Entry>()
        for (line in lines) {
            val d = dateAtStart(line)
            if (d != null) out += Entry(d, mutableListOf(line)) else out.lastOrNull()?.lines?.add(line)
        }
        return out
    }

    private fun dateAtStart(line: String): LocalDate? {
        DATE_A.find(line)?.let { m -> month(m.groupValues[1])?.let { return safe(m.groupValues[3].toInt(), it, m.groupValues[2].toInt()) } }
        DATE_B.find(line)?.let { m -> month(m.groupValues[2])?.let { return safe(year(m.groupValues[3]), it, m.groupValues[1].toInt()) } }
        DATE_C.find(line)?.let { m -> return safe(year(m.groupValues[3]), m.groupValues[2].toInt(), m.groupValues[1].toInt()) }   // day first, as in India
        return null
    }

    private fun month(name: String): Int? = MONTHS.indexOf(name.lowercase().take(3)).takeIf { it >= 0 && name.length <= 9 }?.plus(1)
    private fun year(s: String) = if (s.length == 2) 2000 + s.toInt() else s.toInt()
    private fun safe(y: Int, m: Int, d: Int): LocalDate? = runCatching { LocalDate.of(y, m, d) }.getOrNull()

    private fun clock(m: MatchResult): LocalTime? {
        var h = m.groupValues[1].toInt(); val min = m.groupValues[2].toInt()
        val ap = m.groupValues[3].lowercase()
        if (ap.isNotEmpty()) h = (h % 12) + if (ap == "pm") 12 else 0
        return if (h in 0..23 && min in 0..59) LocalTime.of(h, min) else null
    }

    private val OUT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX")
    private fun iso(d: LocalDate, t: LocalTime?, zone: ZoneId): String =
        LocalDateTime.of(d, t ?: LocalTime.NOON).atZone(zone).format(OUT)

    /** "1,234.5" → 123450 paise, no floating point. */
    fun minor(s: String): Long? {
        val clean = s.replace(",", "")
        val parts = clean.split(".")
        val whole = parts[0].toLongOrNull() ?: return null
        val paise = ((parts.getOrNull(1) ?: "") + "00").take(2).toLongOrNull() ?: return null
        return whole * 100 + paise
    }

    /** Trims, drops trailing punctuation, and title-cases names the statement printed in capitals. */
    private fun tidy(raw: String): String? {
        val s = raw.trim().trimEnd('-', ',', '.', ':', ' ').replace(Regex("""\s+"""), " ")
        if (s.length < 2) return null
        return if (s.any { it.isLowerCase() }) s else s.lowercase().split(' ').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }
    }
}
