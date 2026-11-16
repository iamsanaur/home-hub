package com.e404.homehub.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.DoNotDisturbOn
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.rounded.CheckBox
import androidx.compose.material.icons.rounded.CheckBoxOutlineBlank
import androidx.compose.material.icons.rounded.KeyboardDoubleArrowUp
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.e404.homehub.data.model.Approval
import com.e404.homehub.data.model.Bill
import com.e404.homehub.data.model.GroceryItem
import com.e404.homehub.data.model.Money
import com.e404.homehub.data.model.Priority
import com.e404.homehub.data.model.Task
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Radius
import com.e404.homehub.ui.theme.Space
import com.e404.homehub.ui.util.Dates
import java.time.Instant
import java.time.ZoneId

@Composable
fun PriorityIndicator(priority: Priority) {
    val c = HomeHubTheme.colors
    when (priority) {
        Priority.Urgent -> StatusBadge("Urgent", Tone.Danger, Icons.Rounded.KeyboardDoubleArrowUp)
        Priority.High -> StatusBadge("High", Tone.Warning, Icons.Rounded.KeyboardArrowUp)
        else -> Unit
    }
    if (priority == Priority.Low) Text("Low", style = HomeHubTheme.type.caption, color = c.inkTertiary)
}

@Composable
fun PendingSyncIndicator(pending: Boolean) {
    if (!pending) return
    Icon(Icons.Outlined.CloudSync, contentDescription = "Waiting to sync", tint = HomeHubTheme.colors.inkTertiary, modifier = Modifier.size(16.dp))
}

/** Task row: completion control, title, due, assignee, priority, category; the whole row opens the task. */
@Composable
fun TaskRow(task: Task, zone: ZoneId, assigneeName: String?, onToggle: (Boolean) -> Unit, onOpen: () -> Unit, modifier: Modifier = Modifier, now: Instant = Instant.now()) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val overdue = !task.isDone && task.dueAt != null && task.dueAt.isBefore(now)
    Row(modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen).defaultMinSize(minHeight = 64.dp).padding(end = Space.md), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(56.dp).toggleable(task.isDone, role = Role.Checkbox, onValueChange = onToggle)
                .semantics { contentDescription = "Complete ${task.title}"; stateDescription = if (task.isDone) "Done" else "Not done" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (task.isDone) Icons.Rounded.CheckBox else Icons.Rounded.CheckBoxOutlineBlank, null, tint = if (task.isDone) c.success else c.inkSecondary)
        }
        Column(Modifier.weight(1f).padding(vertical = Space.sm)) {
            Text(task.title, style = t.cardTitle, color = if (task.isDone) c.inkTertiary else c.ink, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (task.isDone) TextDecoration.LineThrough else null)
            Spacer(Modifier.height(2.dp))
            @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
            androidx.compose.foundation.layout.FlowRow(itemVerticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                if (task.dueAt != null) {
                    Icon(if (overdue) Icons.Outlined.WarningAmber else Icons.Outlined.Schedule, null, tint = if (overdue) c.danger else c.inkTertiary, modifier = Modifier.size(14.dp))
                    Text(if (overdue) "Overdue · ${Dates.relative(task.dueAt, zone, now)}" else Dates.relative(task.dueAt, zone, now), style = t.caption, color = if (overdue) c.danger else c.inkSecondary)
                }
                if (task.recurring) Icon(Icons.Outlined.Repeat, "Repeats", tint = c.inkTertiary, modifier = Modifier.size(14.dp))
                if (assigneeName != null) Text("· $assigneeName", style = t.caption, color = c.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (task.category != null) Text("· ${task.category}", style = t.caption, color = c.inkTertiary, maxLines = 1)
            }
        }
        PendingSyncIndicator(task.pendingSync)
        Spacer(Modifier.width(Space.xs))
        PriorityIndicator(task.priority)
    }
}

enum class BillState(val label: String, val tone: Tone) {
    Upcoming("Upcoming", Tone.Neutral), DueToday("Due today", Tone.Warning), Overdue("Overdue", Tone.Danger), Paid("Paid", Tone.Success), NeedsAttention("Needs attention", Tone.Warning)
}

fun billState(bill: Bill, zone: ZoneId, now: Instant = Instant.now()): BillState {
    val due = bill.nextDueAt ?: return BillState.NeedsAttention
    if (bill.amountMinor <= 0) return BillState.NeedsAttention
    val today = now.atZone(zone).toLocalDate()
    val d = due.atZone(zone).toLocalDate()
    // A non-recurring bill paid on/after its due cycle shows as Paid.
    if (bill.recurrence == null && bill.lastPaidAt != null) return BillState.Paid
    return when {
        d.isEqual(today) -> BillState.DueToday
        d.isBefore(today) -> BillState.Overdue
        else -> BillState.Upcoming
    }
}

@Composable
fun BillRow(bill: Bill, zone: ZoneId, onClick: () -> Unit) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val state = billState(bill, zone)
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).defaultMinSize(minHeight = 64.dp).padding(horizontal = Space.md, vertical = Space.sm), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(bill.name, style = t.cardTitle, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                Text(bill.nextDueAt?.let { "Due ${Dates.shortDate(it, zone)}" } ?: "No due date", style = t.caption, color = c.inkSecondary)
                if (bill.recurrence != null) { Icon(Icons.Outlined.Repeat, "Repeats ${bill.recurrence}", tint = c.inkTertiary, modifier = Modifier.size(14.dp)); Text(bill.recurrence.replaceFirstChar { it.uppercase() }, style = t.caption, color = c.inkTertiary) }
                Text("· Reminder ${bill.reminderDaysBefore}d before", style = t.caption, color = c.inkTertiary, maxLines = 1)
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(Money.format(bill.amountMinor, bill.currency), style = t.numeric, color = c.ink)
            Spacer(Modifier.height(4.dp))
            StatusBadge(state.label, state.tone, if (state == BillState.Paid) Icons.Outlined.CheckCircle else if (state == BillState.Overdue) Icons.Outlined.WarningAmber else null)
        }
    }
}

@Composable
fun GroceryItemRow(item: GroceryItem, currency: String, onToggle: (Boolean) -> Unit, onLongPress: () -> Unit) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Row(
        Modifier.fillMaxWidth().toggleable(item.purchased, role = Role.Checkbox, onValueChange = onToggle)
            .semantics { stateDescription = if (item.purchased) "Purchased" else "Not purchased" }
            .defaultMinSize(minHeight = 56.dp).padding(start = Space.xs, end = Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
            Icon(if (item.purchased) Icons.Rounded.CheckBox else Icons.Rounded.CheckBoxOutlineBlank, null, tint = if (item.purchased) c.success else c.inkSecondary)
        }
        Column(Modifier.weight(1f)) {
            Text(item.name, style = t.cardTitle, color = if (item.purchased) c.inkTertiary else c.ink, textDecoration = if (item.purchased) TextDecoration.LineThrough else null)
            Text("${Dates.qty(item.quantity)} ${item.unit}", style = t.caption, color = c.inkSecondary)
        }
        PendingSyncIndicator(item.pendingSync)
        Spacer(Modifier.width(Space.xs))
        val price = item.actualPriceMinor ?: item.estimatedPriceMinor
        if (price != null) Text((if (item.actualPriceMinor == null) "≈ " else "") + Money.format(price, currency), style = t.numeric.copy(fontSize = t.bodyCompact.fontSize), color = c.inkSecondary)
        HomeHubIconButton(Icons.Outlined.DoNotDisturbOn, "Remove ${item.name}", onLongPress, tint = c.inkTertiary)
    }
}

/** Budget snapshot: spent / limit with exact values and a textual summary (accessible). */
@Composable
fun BudgetSummary(spentMinor: Long, limitMinor: Long?, incomeMinor: Long, currency: String, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    val pct = if (limitMinor != null && limitMinor > 0) Money.percent(spentMinor, limitMinor) else null
    val summary = if (limitMinor != null) "Spent ${Money.format(spentMinor, currency)} of ${Money.format(limitMinor, currency)} budget, $pct percent" else "Spent ${Money.format(spentMinor, currency)} this month"
    Column(modifier.semantics(mergeDescendants = true) { contentDescription = summary }) {
        Text("Spent this month", style = t.label, color = c.inkSecondary)
        Row(verticalAlignment = Alignment.Bottom) {
            Text(Money.format(spentMinor, currency), style = t.kpi, color = c.ink)
            if (limitMinor != null) Text("  of ${Money.format(limitMinor, currency)}", style = t.bodyCompact, color = c.inkSecondary, modifier = Modifier.padding(bottom = 4.dp))
        }
        if (pct != null) {
            Spacer(Modifier.height(Space.xs))
            ProgressRow(if (pct > 100) "Over budget" else if (pct >= 85) "Close to budget" else "Within budget", pct / 100f, "$pct%", if (pct > 100) Tone.Danger else if (pct >= 85) Tone.Warning else Tone.Brand)
        }
        if (incomeMinor > 0) { Spacer(Modifier.height(Space.xs)); Text("Income ${Money.format(incomeMinor, currency)}", style = t.caption, color = c.inkSecondary) }
    }
}

enum class AgentState(val label: String, val tone: Tone) {
    Suggested("Suggestion", Tone.Info), Proposal("Plan proposal", Tone.Info), AwaitingApproval("Awaiting approval", Tone.Warning),
    Executing("Working…", Tone.Brand), Completed("Completed · verified", Tone.Success), Partial("Partially completed", Tone.Warning),
    Failed("Failed", Tone.Danger), Cancelled("Cancelled", Tone.Neutral), Paused("Agent paused", Tone.Warning),
    /** Handled by a deterministic on-device command; queued for sync, not server-verified yet. */
    Local("Done on this phone", Tone.Success);

    companion object {
        fun of(s: String?) = when (s) {
            "executing" -> Executing; "awaiting_approval" -> AwaitingApproval; "completed" -> Completed; "partially_completed" -> Partial
            "failed" -> Failed; "cancelled" -> Cancelled; else -> Suggested
        }
    }
}

@Composable
fun AgentStatusIndicator(state: AgentState, modifier: Modifier = Modifier) {
    val icon = when (state) {
        AgentState.Executing -> null
        AgentState.Completed -> Icons.Outlined.TaskAlt
        AgentState.AwaitingApproval -> Icons.Outlined.HourglassTop
        AgentState.Failed -> Icons.Outlined.ErrorOutline
        AgentState.Paused -> Icons.Outlined.PauseCircle
        AgentState.Suggested, AgentState.Proposal -> Icons.Outlined.Lightbulb
        else -> Icons.Outlined.AutoAwesome
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (state == AgentState.Executing && !HomeHubTheme.a11y.reduceMotion) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = HomeHubTheme.colors.brand); Spacer(Modifier.width(6.dp))
        }
        StatusBadge(state.label, state.tone, icon)
    }
}

data class ToolStep(val name: String, val done: Boolean, val ok: Boolean)

/** Tool activity: what the agent touched, in order, and whether each step succeeded. */
@Composable
fun AgentActivityTimeline(steps: List<ToolStep>, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        steps.forEach { s ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(if (!s.done) c.brand else if (s.ok) c.success else c.danger))
                Spacer(Modifier.width(Space.xs))
                Text(s.name.replace('_', ' ').replaceFirstChar { it.uppercase() }, style = t.caption, color = c.inkSecondary, modifier = Modifier.weight(1f))
                Text(if (!s.done) "running" else if (s.ok) "done" else "failed", style = t.caption, color = if (!s.done) c.brand else if (s.ok) c.success else c.danger)
            }
        }
    }
}

/** Approval card (design.md §11): exact action, parameters, cost, recipient, date, data shared, consequences, approve/reject. */
@Composable
fun ApprovalCard(approval: Approval, zone: ZoneId, canDecide: Boolean, busy: Boolean, onApprove: () -> Unit, onReject: () -> Unit, modifier: Modifier = Modifier) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    HomeHubCard(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AutoAwesome, null, tint = c.brand, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(if (approval.agentId != null) "Requested by HomeHub assistant" else "Requested by a household member", style = t.caption, color = c.inkSecondary, modifier = Modifier.weight(1f))
            AgentStatusIndicator(AgentState.AwaitingApproval)
        }
        Spacer(Modifier.height(Space.sm))
        Text(approval.title.replaceFirstChar { it.uppercase() }, style = t.cardTitle, color = c.ink)
        Spacer(Modifier.height(4.dp))
        Text(approval.rationale, style = t.bodyCompact, color = c.inkSecondary)
        Spacer(Modifier.height(Space.sm))
        val details = buildList {
            add("Action" to approvalActionLabel(approval))
            approval.estimatedCostMinor?.let { add("Estimated cost" to Money.format(it, approval.currency ?: "INR")) }
            approval.recipient?.let { add("Recipient" to it) }
            approval.relevantDate?.let { add("Date" to it) }
            approval.dataShared?.let { add("Data shared" to it) }
            approval.consequences?.let { add("Consequences" to it) }
            approvalParamSummary(approval)?.let { add("Details" to it) }
            approval.expiresAt?.let { add("Expires" to Dates.relative(it, zone)) }
        }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.input)).background(c.surfaceSubtle).padding(Space.sm), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            details.forEach { (k, v) ->
                Row { Text(k, style = t.caption, color = c.inkSecondary, modifier = Modifier.width(110.dp)); Text(v, style = t.bodyCompact, color = c.ink) }
            }
        }
        if (approval.manualCompletion) {
            Spacer(Modifier.height(Space.xs))
            Text("HomeHub can't do this externally. Approving records your decision; a person completes it.", style = t.caption, color = c.inkSecondary)
        }
        if (canDecide) {
            Spacer(Modifier.height(Space.md))
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                HomeHubButton("Reject", onReject, Modifier.weight(1f), kind = ButtonKind.Secondary, enabled = !busy)
                HomeHubButton("Approve", onApprove, Modifier.weight(1f), loading = busy)
            }
        }
    }
}

fun approvalActionLabel(a: Approval): String = when (a.action) {
    "agent_tool_call" -> (a.params["tool"] as? String)?.replace('_', ' ')?.replaceFirstChar { it.uppercase() } ?: "Run a household change"
    "purchase_items" -> "Buy items on a shopping list"
    "book_service_provider" -> "Book a service provider"
    "send_external_message" -> "Send a message outside HomeHub"
    "share_information" -> "Share household information"
    "delete_document" -> "Delete a document"
    "record_expense" -> "Record an expense"
    "create_meal_plan" -> "Save a meal plan"
    "create_tasks" -> "Create tasks"
    "add_shopping_items" -> "Add shopping items"
    "create_maintenance_request" -> "Log a maintenance request"
    else -> a.action.replace('_', ' ')
}

private fun approvalParamSummary(a: Approval): String? {
    @Suppress("UNCHECKED_CAST")
    val p = (if (a.action == "agent_tool_call") a.params["args"] as? Map<String, Any?> else a.params) ?: return null
    return p.entries.filter { it.value != null && it.key != "idempotency_key" }.take(6).joinToString(" · ") { (k, v) ->
        val value = when {
            k.endsWith("Minor") && v is Number -> Money.format(v.toLong(), a.currency ?: "INR")
            v is List<*> -> "${v.size} item${if (v.size == 1) "" else "s"}"
            else -> v.toString().take(60)
        }
        "${k.replace('_', ' ')}: $value"
    }.ifEmpty { null }
}
