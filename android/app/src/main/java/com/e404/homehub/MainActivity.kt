package com.e404.homehub

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import com.e404.homehub.ui.HomeHubRoot
import com.e404.homehub.ui.theme.HomeHubTheme

class MainActivity : ComponentActivity() {
    private val deepLink = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        deepLink.value = intent?.data?.toString()
        setContent {
            HomeHubTheme {
                HomeHubRoot(deepLink = deepLink.value, onDeepLinkHandled = { deepLink.value = null })
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Coming back to the app: refresh the live connection so nothing shown is stale.
        lifecycleScope.launch { AppGraph.get(applicationContext).data.resync() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        deepLink.value = intent.data?.toString()
    }
}
