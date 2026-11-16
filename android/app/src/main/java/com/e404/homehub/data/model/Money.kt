package com.e404.homehub.data.model

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/**
 * Money is an integer count of minor units plus an ISO 4217 code. Parsing and
 * formatting go through BigDecimal; Double is never used for amounts.
 */
object Money {
    private val overrides = mapOf(
        "JPY" to 0, "KRW" to 0, "VND" to 0, "CLP" to 0, "ISK" to 0, "UGX" to 0, "XAF" to 0, "XOF" to 0, "PYG" to 0, "RWF" to 0,
        "BHD" to 3, "KWD" to 3, "OMR" to 3, "JOD" to 3, "TND" to 3, "LYD" to 3, "IQD" to 3,
    )

    fun exponent(currency: String): Int = overrides[currency] ?: 2

    /** "1,234.50" → 123450 for INR. Returns null when the text is not a valid amount for the currency. */
    fun parse(text: String, currency: String): Long? {
        val cleaned = text.trim().replace(",", "").replace(" ", "").replace("_", "")
        if (!Regex("^\\d+(\\.\\d+)?$").matches(cleaned)) return null
        val bd = BigDecimal(cleaned)
        if (bd.scale() > exponent(currency)) return null
        return try { bd.movePointRight(exponent(currency)).setScale(0, RoundingMode.UNNECESSARY).longValueExact() } catch (_: ArithmeticException) { null }
    }

    fun format(minor: Long, currency: String, locale: Locale = Locale.getDefault()): String {
        val exp = exponent(currency)
        val nf = NumberFormat.getCurrencyInstance(locale).apply {
            runCatching { this.currency = Currency.getInstance(currency) }
            minimumFractionDigits = exp
            maximumFractionDigits = exp
        }
        return nf.format(BigDecimal.valueOf(minor).movePointLeft(exp))
    }

    /** Integer percentage (0–100+) of part/whole, no floating point. */
    fun percent(part: Long, whole: Long): Int = if (whole <= 0) 0 else ((part * 100) / whole).toInt()

    /** Editable decimal string for a minor amount (e.g. 123450 → "1234.50"). */
    fun toInput(minor: Long, currency: String): String = BigDecimal.valueOf(minor).movePointLeft(exponent(currency)).toPlainString()
}
