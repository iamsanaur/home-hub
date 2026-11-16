package com.e404.homehub.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.e404.homehub.AppGraph
import com.e404.homehub.ui.LocalActions
import com.e404.homehub.ui.LocalHousehold
import com.e404.homehub.ui.components.GroupedList
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubListTile
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.SectionHeader
import com.e404.homehub.ui.theme.HomeHubTheme
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Settings → Your profile: how you appear to the household. Saved on the server for every household you belong to. */
@Composable
fun ProfileSettings() {
    val h = LocalHousehold.current
    val nav = LocalActions.current
    val graph = AppGraph.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    val t = HomeHubTheme.type
    val c = HomeHubTheme.colors
    var editing by remember { mutableStateOf(false) }
    val current = h.me?.displayName.orEmpty()
    val email = graph.auth.currentUser?.email
    // A name that is really the email address (nothing was ever set) starts blank so it's obvious what to type.
    val looksLikeEmail = current.contains('@')

    Column {
        SectionHeader("Your profile")
        GroupedList {
            HomeHubListTile(
                if (current.isBlank() || looksLikeEmail) "Add your name" else current,
                subtitle = email,
                leadingIcon = Icons.Outlined.Person,
                trailing = { Text("Edit", style = t.label, color = c.brand) },
                onClick = { editing = true },
            )
        }
    }
    if (editing) FormSheet("Your name", { editing = false }) {
        var name by remember { mutableStateOf(if (looksLikeEmail) "" else current) }
        var saving by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        HomeHubTextField("Name", name, { name = it; error = null }, error = error, helper = "Shown to everyone in your households, instead of your email.")
        HomeHubButton("Save", {
            saving = true
            scope.launch {
                runCatching {
                    graph.gateway.call("PATCH", "/v1/me", buildJsonObject { put("displayName", name.trim()) })
                    graph.auth.currentUser?.reload()?.await()
                }.onSuccess { nav.toast("Name updated"); editing = false }
                    .onFailure { error = it.message ?: "Couldn't save your name"; saving = false }
            }
        }, Modifier.fillMaxWidth(), enabled = name.trim().isNotEmpty() && name.trim() != current, loading = saving)
    }
}
