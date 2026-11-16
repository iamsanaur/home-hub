package com.e404.homehub.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Radius
import com.e404.homehub.ui.theme.Space

enum class ButtonKind { Primary, Secondary, Tertiary, Destructive }

/** One primary per viewport. Every button has pressed (ripple), disabled, loading and focus states and an accessible label. */
@Composable
fun HomeHubButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Primary,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val shape = RoundedCornerShape(Radius.input)
    val content: @Composable RowScope.() -> Unit = {
        if (loading) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = if (kind == ButtonKind.Primary) c.onBrand else c.brand)
            Spacer(Modifier.width(Space.xs))
        } else if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(Space.xs))
        }
        Text(text, style = t.label.copy(fontSize = t.cardTitle.fontSize), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    val mod = modifier.heightIn(min = 48.dp).semantics { if (loading) contentDescription = "$text, in progress" }
    val active = enabled && !loading
    when (kind) {
        ButtonKind.Primary -> Button(onClick, mod, enabled = active, shape = shape, contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm),
            colors = ButtonDefaults.buttonColors(containerColor = c.brand, contentColor = c.onBrand, disabledContainerColor = c.brand.copy(alpha = 0.38f), disabledContentColor = c.onBrand.copy(alpha = 0.8f)), content = content)
        ButtonKind.Destructive -> Button(onClick, mod, enabled = active, shape = shape, contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm),
            colors = ButtonDefaults.buttonColors(containerColor = c.danger, contentColor = Color.White), content = content)
        ButtonKind.Secondary -> OutlinedButton(onClick, mod, enabled = active, shape = shape, border = BorderStroke(1.dp, c.border),
            colors = ButtonDefaults.outlinedButtonColors(containerColor = c.surface, contentColor = c.ink), contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.sm), content = content)
        ButtonKind.Tertiary -> TextButton(onClick, mod, enabled = active, colors = ButtonDefaults.textButtonColors(contentColor = c.brand), content = content)
    }
}

@Composable
fun HomeHubIconButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = HomeHubTheme.colors.inkSecondary, enabled: Boolean = true, size: Dp = 24.dp) {
    IconButton(onClick = onClick, modifier = modifier.size(48.dp), enabled = enabled) { Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(size)) }
}

/** Persistent label above the field, inline validation, helper text; never placeholder-only. */
@Composable
fun HomeHubTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    helper: String? = null,
    error: String? = null,
    optional: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    singleLine: Boolean = true,
    minLines: Int = 1,
    password: Boolean = false,
    placeholder: String? = null,
) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Column(modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(label, style = t.label, color = c.ink)
            if (optional) Text("  Optional", style = t.caption, color = c.inkTertiary)
        }
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = value, onValueChange = onValueChange, modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
            textStyle = t.body.copy(color = c.ink), singleLine = singleLine, minLines = minLines, isError = error != null,
            placeholder = placeholder?.let { { Text(it, style = t.body, color = c.inkTertiary) } },
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
            visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            shape = RoundedCornerShape(Radius.input),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = c.brand, unfocusedBorderColor = c.border, errorBorderColor = c.danger,
                focusedContainerColor = c.surface, unfocusedContainerColor = c.surface, cursorColor = c.brand,
            ),
        )
        val supporting = error ?: helper
        if (supporting != null) {
            Spacer(Modifier.height(4.dp))
            Text(supporting, style = t.caption, color = if (error != null) c.danger else c.inkSecondary, modifier = Modifier.semantics { if (error != null) liveRegion = LiveRegionMode.Polite })
        }
    }
}

@Composable
fun HomeHubSearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    OutlinedTextField(
        value = value, onValueChange = onValueChange, modifier = modifier.fillMaxWidth().semantics { contentDescription = placeholder },
        leadingIcon = { Icon(Icons.Outlined.Search, null, tint = c.inkSecondary) },
        placeholder = { Text(placeholder, color = c.inkTertiary) }, singleLine = true, shape = RoundedCornerShape(Radius.input),
        textStyle = HomeHubTheme.type.body.copy(color = c.ink),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = c.brand, unfocusedBorderColor = c.border, focusedContainerColor = c.surface, unfocusedContainerColor = c.surface),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    )
}

/** Solid content-layer surface (never glass). */
@Composable
fun HomeHubCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, padding: PaddingValues = PaddingValues(Space.md), content: @Composable ColumnScope.() -> Unit) {
    val c = HomeHubTheme.colors
    val shape = RoundedCornerShape(Radius.card)
    Column(
        modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.border, shape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier).padding(padding),
        content = content,
    )
}

@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    val c = HomeHubTheme.colors
    Row(modifier.fillMaxWidth().padding(top = Space.xl, bottom = Space.xs), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HomeHubTheme.type.sectionTitle, color = c.ink, modifier = Modifier.weight(1f).semantics { heading() })
        // Plain link like the iOS header (44dp target, no button padding).
        if (action != null && onAction != null) Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onAction).padding(start = Space.sm), contentAlignment = Alignment.CenterEnd) {
            Text(action, style = HomeHubTheme.type.label, color = c.brand)
        }
    }
}

@Composable
fun HomeHubListTile(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leadingIcon: ImageVector? = null,
    leadingTint: Color = HomeHubTheme.colors.brand,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    /** Disclosure chevron like the iOS rows; defaults to on for tappable rows without other trailing content. */
    chevron: Boolean = onClick != null && trailing == null,
) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Row(
        modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .defaultMinSize(minHeight = 56.dp).padding(horizontal = Space.md, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leadingIcon != null) {
            Box(Modifier.size(36.dp).clip(RoundedCornerShape(Radius.control)).background(c.brandTint), contentAlignment = Alignment.Center) {
                Icon(leadingIcon, null, tint = leadingTint, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(Space.sm))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = t.cardTitle, color = c.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = t.bodyCompact, color = c.inkSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        trailing?.invoke()
        if (chevron) Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = c.inkTertiary, modifier = Modifier.padding(start = Space.xs).size(26.dp))
    }
}

enum class Tone { Neutral, Brand, Success, Warning, Danger, Info, Gold }

@Composable
fun toneColor(tone: Tone): Color {
    val c = HomeHubTheme.colors
    return when (tone) {
        Tone.Neutral -> c.inkSecondary; Tone.Brand -> c.brand; Tone.Success -> c.success; Tone.Warning -> c.warning
        Tone.Danger -> c.danger; Tone.Info -> c.info; Tone.Gold -> c.warning
    }
}

/** Status is always label + icon (+ colour), never colour alone. */
@Composable
fun StatusBadge(label: String, tone: Tone, icon: ImageVector? = null, modifier: Modifier = Modifier) {
    val col = toneColor(tone)
    Row(
        modifier.clip(RoundedCornerShape(50)).background(col.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = col, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp)) }
        Text(label, style = HomeHubTheme.type.caption, color = col, maxLines = 1)
    }
}

@Composable
fun ProgressRow(label: String, fraction: Float, valueText: String, tone: Tone = Tone.Brand, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    Column(modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row(Modifier.fillMaxWidth()) {
            Text(label, style = HomeHubTheme.type.bodyCompact, color = c.ink, modifier = Modifier.weight(1f))
            Text(valueText, style = HomeHubTheme.type.numeric.copy(fontSize = HomeHubTheme.type.bodyCompact.fontSize), color = c.inkSecondary)
        }
        Spacer(Modifier.height(6.dp))
        LinearProgressIndicator(
            progress = { fraction.coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
            color = toneColor(tone), trackColor = c.surfaceSubtle, drawStopIndicator = {},
        )
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, message: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    val c = HomeHubTheme.colors
    Column(modifier.fillMaxWidth().padding(vertical = Space.xxl, horizontal = Space.lg), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(56.dp).clip(CircleShape).background(c.brandTint), contentAlignment = Alignment.Center) { Icon(icon, null, tint = c.brand) }
        Spacer(Modifier.height(Space.md))
        Text(title, style = HomeHubTheme.type.cardTitle, color = c.ink)
        Spacer(Modifier.height(Space.xxs))
        Text(message, style = HomeHubTheme.type.bodyCompact, color = c.inkSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (actionLabel != null && onAction != null) { Spacer(Modifier.height(Space.md)); HomeHubButton(actionLabel, onAction, kind = ButtonKind.Secondary) }
    }
}

@Composable
fun ErrorState(message: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null, offline: Boolean = false) {
    EmptyState(if (offline) Icons.Outlined.CloudOff else Icons.Outlined.ErrorOutline, if (offline) "You're offline" else "Something went wrong", message, modifier, if (onRetry != null) "Try again" else null, onRetry)
}

/** Shimmer-free skeleton (static under reduced motion). */
@Composable
fun LoadingSkeleton(rows: Int = 4, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    val reduce = HomeHubTheme.a11y.reduceMotion
    val alpha = if (reduce) 0.6f else {
        val tr = rememberInfiniteTransition(label = "skeleton")
        val a by tr.animateFloat(0.45f, 0.85f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "a")
        a
    }
    Column(modifier.fillMaxWidth().semantics { contentDescription = "Loading" }, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        repeat(rows) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(36.dp).clip(RoundedCornerShape(Radius.control)).background(c.surfaceSubtle).alpha(alpha))
                Spacer(Modifier.width(Space.sm))
                Column(Modifier.weight(1f)) {
                    Box(Modifier.fillMaxWidth(0.7f).height(14.dp).clip(RoundedCornerShape(4.dp)).background(c.surfaceSubtle).alpha(alpha))
                    Spacer(Modifier.height(6.dp))
                    Box(Modifier.fillMaxWidth(0.4f).height(12.dp).clip(RoundedCornerShape(4.dp)).background(c.surfaceSubtle).alpha(alpha))
                }
            }
        }
    }
}

@Composable
fun MemberAvatar(initials: String, modifier: Modifier = Modifier, size: Int = 36, label: String? = null) {
    val c = HomeHubTheme.colors
    Box(
        modifier.size(size.dp).clip(CircleShape).background(c.sage.copy(alpha = if (c.isDark) 0.5f else 0.45f)).semantics { label?.let { contentDescription = it } },
        contentAlignment = Alignment.Center,
    ) { Text(initials, style = HomeHubTheme.type.label, color = c.ink) }
}

/**
 * Filters, drawn like the iOS app: up to four options become a full-width segmented control
 * (grey track, raised white selection); more options become scrollable capsule chips.
 */
@Composable
fun SegmentedFilter(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    if (options.size <= 4) {
        Row(
            modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(c.ink.copy(alpha = if (c.isDark) 0.16f else 0.07f)).padding(3.dp).selectableGroup(),
        ) {
            options.forEachIndexed { i, label ->
                val sel = i == selected
                Box(
                    Modifier.weight(1f).heightIn(min = 40.dp)
                        .then(if (sel) Modifier.shadow(2.dp, RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(c.surface) else Modifier.clip(RoundedCornerShape(50)))
                        .selectable(sel, role = Role.Tab) { onSelect(i) },
                    contentAlignment = Alignment.Center,
                ) { Text(label, style = t.bodyCompact.copy(fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal), color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
    } else {
        Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
            options.forEachIndexed { i, label ->
                val sel = i == selected
                Text(label, style = t.label, color = c.ink, maxLines = 1,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(if (sel) c.brandTint else c.surface)
                        .border(1.dp, if (sel) c.brand.copy(alpha = 0.5f) else c.border, RoundedCornerShape(50))
                        .selectable(sel, role = Role.Tab) { onSelect(i) }.heightIn(min = 40.dp).padding(horizontal = 14.dp, vertical = 11.dp))
            }
        }
    }
}

@Composable
fun ConfirmationDialog(title: String, message: String, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit, destructive: Boolean = false) {
    val c = HomeHubTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = HomeHubTheme.type.sectionTitle) },
        text = { Text(message, style = HomeHubTheme.type.body, color = c.inkSecondary) },
        confirmButton = { TextButton(onConfirm) { Text(confirmLabel, color = if (destructive) c.danger else c.brand, style = HomeHubTheme.type.label) } },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = c.inkSecondary, style = HomeHubTheme.type.label) } },
        containerColor = c.surfaceElevated,
    )
}

@Composable
fun Divider(modifier: Modifier = Modifier) = HorizontalDivider(modifier, color = HomeHubTheme.colors.border, thickness = 1.dp)

/** A grouped solid list container (rows separated by hairlines), used instead of a card per item. */
@Composable
fun GroupedList(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = HomeHubTheme.colors
    val shape = RoundedCornerShape(Radius.card)
    Column(modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.border, shape), content = content)
}

@Composable
fun PasswordField(label: String, value: String, onValueChange: (String) -> Unit, error: String? = null, imeAction: ImeAction = ImeAction.Done) =
    HomeHubTextField(label, value, onValueChange, error = error, keyboardType = KeyboardType.Password, imeAction = imeAction, password = true)
