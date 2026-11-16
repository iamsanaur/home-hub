package com.e404.homehub.ui.util

import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** Localised, household-timezone-aware formatting. Pure functions → unit tested. */
object Dates {
    fun zone(id: String?): ZoneId = runCatching { ZoneId.of(id ?: "UTC") }.getOrDefault(ZoneId.systemDefault())

    fun relative(instant: Instant, zone: ZoneId, now: Instant = Instant.now(), locale: Locale = Locale.getDefault()): String {
        val d = instant.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(today, d.toLocalDate())
        val time = d.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
        return when (days) {
            0L -> "Today $time"
            1L -> "Tomorrow $time"
            -1L -> "Yesterday $time"
            in 2..6 -> "${d.dayOfWeek.getDisplayName(java.time.format.TextStyle.FULL, locale)} $time"
            else -> d.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
        }
    }

    fun shortDate(instant: Instant, zone: ZoneId, locale: Locale = Locale.getDefault()): String =
        instant.atZone(zone).format(DateTimeFormatter.ofPattern("d MMM", locale))

    fun longDate(date: LocalDate, locale: Locale = Locale.getDefault()): String =
        date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(locale))

    fun time(instant: Instant, zone: ZoneId, locale: Locale = Locale.getDefault()): String =
        instant.atZone(zone).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))

    /** Quantities without float noise: 0.3 → "0.3", 2.0 → "2". */
    fun qty(q: Double): String = BigDecimal.valueOf(q).stripTrailingZeros().toPlainString()

    fun greeting(now: Instant, zone: ZoneId): String = when (now.atZone(zone).hour) {
        in 5..11 -> "Good morning"
        in 12..16 -> "Good afternoon"
        else -> "Good evening"
    }
}
