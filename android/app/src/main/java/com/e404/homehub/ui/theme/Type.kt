package com.e404.homehub.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** Type scale from design.md §2.3 on the platform face (Roboto). All sizes in sp so they follow the user's font scale. */
@Immutable
data class HomeHubType(
    val display: TextStyle,
    val screenTitle: TextStyle,
    val sectionTitle: TextStyle,
    val cardTitle: TextStyle,
    val body: TextStyle,
    val bodyCompact: TextStyle,
    val label: TextStyle,
    val caption: TextStyle,
    val kpi: TextStyle,
    /** Tabular numerals for money, dates, quantities and metrics. */
    val numeric: TextStyle,
)

private fun style(size: Int, weight: Int, lh: Float, tracking: Float = 0f) = TextStyle(
    fontFamily = FontFamily.Default,
    fontSize = size.sp,
    fontWeight = FontWeight(weight),
    lineHeight = (size * lh).sp,
    letterSpacing = tracking.em,
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
)

// Sizes mirror the iOS text styles at default Dynamic Type (largeTitle 34, title3 20, headline 17,
// body 17, subheadline 15, footnote 13, caption 12) so both apps read the same.
val DefaultType = HomeHubType(
    display = style(32, 700, 1.15f, -0.02f),
    screenTitle = style(34, 700, 1.2f, -0.01f),
    sectionTitle = style(20, 600, 1.25f, -0.005f),
    cardTitle = style(17, 600, 1.3f),
    body = style(17, 400, 1.35f),
    bodyCompact = style(15, 400, 1.35f),
    label = style(13, 600, 1.3f),
    caption = style(12, 500, 1.3f),
    kpi = style(34, 700, 1.1f, -0.01f).copy(fontFeatureSettings = "tnum"),
    numeric = style(17, 500, 1.3f).copy(fontFeatureSettings = "tnum"),
)

val LocalHomeHubType = staticCompositionLocalOf { DefaultType }
