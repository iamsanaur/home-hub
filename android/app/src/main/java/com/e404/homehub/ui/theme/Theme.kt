package com.e404.homehub.ui.theme

import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/** Single entry point for HomeHub tokens. */
object HomeHubTheme {
    val colors: HomeHubColors @Composable get() = LocalHomeHubColors.current
    val type: HomeHubType @Composable get() = LocalHomeHubType.current
    val a11y: A11yPrefs @Composable get() = LocalA11yPrefs.current
}

@Composable
fun HomeHubTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    reduceTransparencyOverride: Boolean? = null,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colors = if (darkTheme) DarkColors else LightColors
    val prefs = remember(reduceTransparencyOverride) {
        val resolver = context.contentResolver
        // Android has no "reduce transparency" switch; high-contrast text is the closest platform signal.
        val highContrast = runCatching { Settings.Secure.getInt(resolver, "high_text_contrast_enabled", 0) == 1 }.getOrDefault(false)
        val animScale = runCatching { Settings.Global.getFloat(resolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 1f) }.getOrDefault(1f)
        val am = context.getSystemService(android.app.ActivityManager::class.java)
        A11yPrefs(
            reduceTransparency = reduceTransparencyOverride ?: highContrast,
            reduceMotion = animScale == 0f,
            blurSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && am?.isLowRamDevice != true,
        )
    }
    // Material 3 still drives interaction semantics (ripples, focus, a11y); the visual roles map to HomeHub tokens.
    val scheme = if (darkTheme) darkColorScheme(
        primary = colors.brand, onPrimary = colors.onBrand, primaryContainer = colors.brandTint,
        background = colors.canvas, surface = colors.surface, onSurface = colors.ink, onBackground = colors.ink,
        surfaceVariant = colors.surfaceSubtle, onSurfaceVariant = colors.inkSecondary, outline = colors.border,
        error = colors.danger, secondary = colors.sage, tertiary = colors.gold,
    ) else lightColorScheme(
        primary = colors.brand, onPrimary = colors.onBrand, primaryContainer = colors.brandTint,
        background = colors.canvas, surface = colors.surface, onSurface = colors.ink, onBackground = colors.ink,
        surfaceVariant = colors.surfaceSubtle, onSurfaceVariant = colors.inkSecondary, outline = colors.border,
        error = colors.danger, secondary = colors.sage, tertiary = colors.gold,
    )
    CompositionLocalProvider(
        LocalHomeHubColors provides colors,
        LocalHomeHubType provides DefaultType,
        LocalA11yPrefs provides prefs,
    ) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
