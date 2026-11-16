package com.e404.homehub.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.activity.compose.BackHandler
import com.e404.homehub.AppGraph
import com.e404.homehub.R
import com.e404.homehub.ui.components.ButtonKind
import com.e404.homehub.ui.components.HomeHubButton
import com.e404.homehub.ui.components.HomeHubTextField
import com.e404.homehub.ui.components.PasswordField
import com.e404.homehub.ui.theme.HomeHubTheme
import com.e404.homehub.ui.theme.Space
import kotlinx.coroutines.launch

private enum class AuthStep { Welcome, SignIn, SignUp, Reset }

@Composable
fun AuthFlow() {
    var step by rememberSaveable { mutableStateOf(AuthStep.Welcome) }
    BackHandler(step != AuthStep.Welcome) { step = AuthStep.Welcome }
    when (step) {
        AuthStep.Welcome -> Welcome(onSignIn = { step = AuthStep.SignIn }, onCreate = { step = AuthStep.SignUp })
        AuthStep.SignIn -> SignIn(onCreate = { step = AuthStep.SignUp }, onForgot = { step = AuthStep.Reset })
        AuthStep.SignUp -> SignUp(onHaveAccount = { step = AuthStep.SignIn })
        AuthStep.Reset -> ResetPassword(onDone = { step = AuthStep.SignIn })
    }
}

@Composable
private fun Welcome(onSignIn: () -> Unit, onCreate: () -> Unit) {
    val c = HomeHubTheme.colors
    val t = HomeHubTheme.type
    Box(Modifier.fillMaxSize().background(c.canvas).windowInsetsPadding(WindowInsets.safeDrawing)) {
        CenteredColumn(Modifier.verticalScroll(rememberScrollState())) {
            Gap(48)
            Image(painterResource(R.drawable.brand_mark), contentDescription = "HomeHub logo", modifier = Modifier.size(88.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(22.dp)))
            Gap(24)
            Text("HomeHub AI", style = t.display, color = c.ink)
            Text("Your Agentic Household Manager", style = t.body, color = c.inkSecondary)
            Gap(32)
            listOf(
                Triple(Icons.Outlined.Checklist, "Everything at home, in one place", "Tasks, shopping, meals, bills and maintenance, shared with the people you live with."),
                Triple(Icons.Outlined.AutoAwesome, "An assistant that does the busywork", "Plans your week, builds lists and reminders — and shows exactly what it did."),
                Triple(Icons.Outlined.VerifiedUser, "You stay in control", "Purchases, payments and bookings always wait for a person to approve them."),
            ).forEach { (icon, title, body) ->
                Row(Modifier.padding(vertical = Space.sm)) {
                    Icon(icon, null, tint = c.brand, modifier = Modifier.size(24.dp))
                    Column(Modifier.padding(start = Space.md)) {
                        Text(title, style = t.cardTitle, color = c.ink)
                        Text(body, style = t.bodyCompact, color = c.inkSecondary)
                    }
                }
            }
            Gap(32)
            HomeHubButton("Create account", onCreate, Modifier.fillMaxWidth())
            Gap(8)
            HomeHubButton("Sign in", onSignIn, Modifier.fillMaxWidth(), kind = ButtonKind.Secondary)
            Gap(32)
        }
    }
}

@Composable
private fun AuthFrame(title: String, subtitle: String, content: @Composable () -> Unit) {
    val c = HomeHubTheme.colors
    Box(Modifier.fillMaxSize().background(c.canvas).windowInsetsPadding(WindowInsets.safeDrawing)) {
        CenteredColumn(Modifier.verticalScroll(rememberScrollState())) {
            Gap(48)
            Image(painterResource(R.drawable.brand_mark), contentDescription = null, modifier = Modifier.size(56.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(14.dp)))
            Gap(16)
            Text(title, style = HomeHubTheme.type.screenTitle, color = c.ink)
            Text(subtitle, style = HomeHubTheme.type.bodyCompact, color = c.inkSecondary)
            Gap(24)
            content()
            Gap(32)
        }
    }
}

@Composable
private fun FormError(message: String?) {
    if (message == null) return
    Text(message, style = HomeHubTheme.type.bodyCompact, color = HomeHubTheme.colors.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
    Gap(8)
}

@Composable
private fun SignIn(onCreate: () -> Unit, onForgot: () -> Unit) {
    val session = AppGraph.get(LocalContext.current).session
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AuthFrame("Welcome back", "Sign in to your household.") {
        HomeHubTextField("Email", email, { email = it }, keyboardType = KeyboardType.Email)
        Gap()
        PasswordField("Password", password, { password = it })
        Gap()
        FormError(error)
        HomeHubButton("Sign in", {
            if (email.isBlank() || password.isBlank()) { error = "Enter your email and password."; return@HomeHubButton }
            busy = true; error = null
            scope.launch { runCatching { session.signIn(email, password) }.onFailure { error = it.message }; busy = false }
        }, Modifier.fillMaxWidth(), loading = busy)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            HomeHubButton("Forgot password?", onForgot, kind = ButtonKind.Tertiary)
            HomeHubButton("Create account", onCreate, kind = ButtonKind.Tertiary)
        }
    }
}

@Composable
private fun SignUp(onHaveAccount: () -> Unit) {
    val session = AppGraph.get(LocalContext.current).session
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var tried by remember { mutableStateOf(false) }
    val pwError = if (tried && password.length < 8) "Use at least 8 characters." else null
    AuthFrame("Create your account", "It takes a minute. You can invite your household next.") {
        HomeHubTextField("Your name", name, { name = it }, error = if (tried && name.isBlank()) "Tell us what to call you." else null)
        Gap()
        HomeHubTextField("Email", email, { email = it }, keyboardType = KeyboardType.Email, helper = "Used to sign in and to accept household invitations.")
        Gap()
        PasswordField("Password", password, { password = it }, error = pwError, imeAction = ImeAction.Done)
        Gap()
        FormError(error)
        HomeHubButton("Create account", {
            tried = true
            if (name.isBlank() || password.length < 8 || email.isBlank()) return@HomeHubButton
            busy = true; error = null
            scope.launch { runCatching { session.signUp(name, email, password) }.onFailure { error = it.message }; busy = false }
        }, Modifier.fillMaxWidth(), loading = busy)
        HomeHubButton("I already have an account", onHaveAccount, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
    }
}

@Composable
private fun ResetPassword(onDone: () -> Unit) {
    val session = AppGraph.get(LocalContext.current).session
    val scope = rememberCoroutineScope()
    var email by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AuthFrame("Reset your password", "We'll email you a link to choose a new one.") {
        if (sent) {
            Text("Check $email for a reset link. It can take a few minutes to arrive.", style = HomeHubTheme.type.body, color = HomeHubTheme.colors.ink, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            Gap(16)
            HomeHubButton("Back to sign in", onDone, Modifier.fillMaxWidth())
        } else {
            HomeHubTextField("Email", email, { email = it }, keyboardType = KeyboardType.Email, imeAction = ImeAction.Done)
            Gap()
            FormError(error)
            HomeHubButton("Send reset link", {
                if (email.isBlank()) { error = "Enter the email you signed up with."; return@HomeHubButton }
                busy = true
                scope.launch { runCatching { session.sendReset(email) }.onSuccess { sent = true }.onFailure { error = it.message }; busy = false }
            }, Modifier.fillMaxWidth(), loading = busy)
            HomeHubButton("Back to sign in", onDone, Modifier.fillMaxWidth(), kind = ButtonKind.Tertiary)
        }
    }
}
