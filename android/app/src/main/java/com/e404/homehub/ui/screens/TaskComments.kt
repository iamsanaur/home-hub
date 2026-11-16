package com.e404.homehub.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.e404.homehub.AppGraph
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.util.Dates
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Query
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.Instant

private data class Comment(val id: String, val authorUid: String, val body: String, val at: Instant?, val byAssistant: Boolean)

/** Comments on one task, live. Adults and the person the task is assigned to can read and add; comments can't be edited. */
@Composable
fun TaskComments(taskId: String) {
    val h = LocalHousehold.current
    val graph = AppGraph.get(LocalContext.current)
    val nav = LocalActions.current
    val scope = rememberCoroutineScope()
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    var items by remember(taskId) { mutableStateOf<List<Comment>>(emptyList()) }
    var text by remember(taskId) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    DisposableEffect(taskId) {
        val reg = graph.firestore.collection("households/${h.hid}/tasks/$taskId/comments").orderBy("createdAt", Query.Direction.ASCENDING).limit(100)
            .addSnapshotListener { s, _ ->
                if (s != null) items = s.documents.map { d -> Comment(d.id, d.getString("authorUid") ?: "", d.getString("body") ?: "", (d.get("createdAt") as? Timestamp)?.toDate()?.toInstant(), d.getString("source") == "agent") }
            }
        onDispose { reg.remove() }
    }
    Text("Comments", style = t.label, color = c.ink)
    if (items.isEmpty()) Text("No comments yet.", style = t.bodyCompact, color = c.inkSecondary)
    items.forEach { m ->
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text((if (m.byAssistant) "Assistant" else h.nameOf(m.authorUid)) + (m.at?.let { " · " + Dates.relative(it, h.zone) } ?: ""), style = t.caption, color = c.inkSecondary)
            Text(m.body, style = t.body, color = c.ink)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
        HomeHubTextField("Add a comment", text, { text = it }, Modifier.weight(1f), singleLine = false, minLines = 1)
        HomeHubButton("Send", {
            val body = text.trim()
            if (body.isEmpty()) return@HomeHubButton
            sending = true
            scope.launch {
                runCatching {
                    graph.firestore.collection("households/${h.hid}/tasks/$taskId/comments").add(mapOf("householdId" to h.hid, "authorUid" to h.uid, "body" to body.take(2000), "createdAt" to FieldValue.serverTimestamp())).await()
                }.onSuccess { text = "" }.onFailure { nav.toast(it.message ?: "Couldn't send") }
                sending = false
            }
        }, enabled = text.isNotBlank() && !sending, loading = sending)
    }
}
