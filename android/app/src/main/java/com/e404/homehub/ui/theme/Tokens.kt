package com.e404.homehub.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * HomeHub semantic colour tokens (design.md §2.1). Feature code uses these roles,
 * never raw hex. Values were checked for WCAG 2.2 AA on their intended surfaces;
 * see docs/design-tokens.md for the measured ratios and the adjusted tokens.
 */
@Immutable
data class HomeHubColors(
    val canvas: Color,
    val surface: Color,
    val surfaceSubtle: Color,
    val surfaceElevated: Color,
    val ink: Color,
    val inkSecondary: Color,
    val inkTertiary: Color,
    val brand: Color,
    val brandStrong: Color,
    val brandTint: Color,
    val onBrand: Color,
    val sage: Color,
    val gold: Color,
    val terracotta: Color,
    val border: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
    val info: Color,
    // Glass material tints (functional layer only)
    val glassTint: Color,
    val glassHighlight: Color,
    val glassShadow: Color,
    val isDark: Boolean,
)

val LightColors = HomeHubColors(
    canvas = Color(0xFFF6F7F2),
    surface = Color(0xFFFFFFFF),
    surfaceSubtle = Color(0xFFEEF1E9),
    surfaceElevated = Color(0xFFFFFFFF),
    ink = Color(0xFF18231D),
    inkSecondary = Color(0xFF536158),
    // design.md lists #758078 (3.81:1 on canvas). Darkened to #66716A → 4.72:1 on canvas, 5.08:1 on white (measured).
    inkTertiary = Color(0xFF66716A),
    brand = Color(0xFF176B45),
    brandStrong = Color(0xFF105638),
    brandTint = Color(0xFFE1F0E6),
    onBrand = Color(0xFFFFFFFF),
    sage = Color(0xFFA8BFA7),
    gold = Color(0xFFD6A344),
    terracotta = Color(0xFFB9674E),
    border = Color(0xFFDCE3DA),
    success = Color(0xFF28764D),
    warning = Color(0xFF94600B),
    danger = Color(0xFFB33B36),
    info = Color(0xFF356C9A),
    glassTint = Color(0xFFF6F7F2),
    glassHighlight = Color(0xFFFFFFFF),
    glassShadow = Color(0xFF18231D),
    isDark = false,
)

val DarkColors = HomeHubColors(
    canvas = Color(0xFF101713),
    surface = Color(0xFF18221C),
    surfaceSubtle = Color(0xFF202D24),
    surfaceElevated = Color(0xFF26352B),
    ink = Color(0xFFF1F5EF),
    inkSecondary = Color(0xFFC0CCC2),
    inkTertiary = Color(0xFF9BA99E),
    brand = Color(0xFF83C69A),
    brandStrong = Color(0xFFA2D8B1),
    brandTint = Color(0xFF233C2C),
    onBrand = Color(0xFF0C2416),
    sage = Color(0xFF789B7D),
    gold = Color(0xFFE4BB68),
    terracotta = Color(0xFFD58B72),
    border = Color(0xFF344238),
    success = Color(0xFF83C69A),
    warning = Color(0xFFE4BB68),
    danger = Color(0xFFF08B83),
    info = Color(0xFF8CB8E0),
    glassTint = Color(0xFF18221C),
    glassHighlight = Color(0xFFFFFFFF),
    glassShadow = Color(0xFF000000),
    isDark = true,
)

/** 8-point spacing scale (design.md §4). */
object Space {
    val xxs = 4.dp
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 20.dp
    val xl = 24.dp
    val xxl = 32.dp
    val xxxl = 40.dp
    val huge = 48.dp
    val giant = 64.dp
}

/** Shape tokens (design.md §4). */
object Radius {
    val control = 10.dp
    val input = 12.dp
    val card = 18.dp
    val panel = 24.dp
    val sheet = 28.dp
}

/** Glass strengths (design.md §3.2) — starting values, tuned on device. */
enum class GlassStrength(val blur: Float, val lightTint: Float, val darkTint: Float, val border: Float, val radius: Float) {
    Subtle(8f, 0.58f, 0.48f, 0.22f, 18f),
    Regular(14f, 0.70f, 0.62f, 0.30f, 22f),
    Prominent(20f, 0.82f, 0.76f, 0.38f, 26f),
}

/** Accessibility and performance signals that change rendering. */
@Immutable
data class A11yPrefs(
    val reduceTransparency: Boolean = false,
    val reduceMotion: Boolean = false,
    /** True when the device can run RenderEffect blur (API 31+) without known perf pressure. */
    val blurSupported: Boolean = true,
)

val LocalHomeHubColors = staticCompositionLocalOf { LightColors }
val LocalA11yPrefs = staticCompositionLocalOf { A11yPrefs() }
