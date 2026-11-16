package com.e404.homehub.data.remote

import android.content.Context
import android.util.Log
import com.e404.homehub.BuildConfig
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.PersistentCacheSettings
import com.google.firebase.storage.FirebaseStorage

/**
 * Initialises Firebase either from google-services.json (real project) or, when that
 * file is absent, with a demo configuration wired to the local Emulator Suite.
 * No credentials live in source code.
 */
object FirebaseBootstrap {
    const val PROJECT_ID_DEMO = "demo-homehub"
    const val REGION = "asia-south1"
    const val PORT_AUTH = 9099
    const val PORT_FIRESTORE = 8181
    const val PORT_STORAGE = 9199
    const val PORT_FUNCTIONS = 5001

    @Volatile var usingEmulators = false; private set
    @Volatile private var done = false

    fun init(context: Context) {
        if (done) return
        synchronized(this) {
            if (done) return
            val app = FirebaseApp.getApps(context).firstOrNull() ?: if (BuildConfig.HAS_GOOGLE_SERVICES) {
                FirebaseApp.initializeApp(context)!!
            } else {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(PROJECT_ID_DEMO)
                        .setApplicationId("1:000000000000:android:0000000000000000")
                        .setApiKey("demo-api-key-for-emulator-only")
                        .setStorageBucket("$PROJECT_ID_DEMO.appspot.com")
                        .build(),
                )
            }
            usingEmulators = BuildConfig.USE_EMULATORS || !BuildConfig.HAS_GOOGLE_SERVICES
            val firestore = FirebaseFirestore.getInstance(app)
            if (usingEmulators) {
                val host = BuildConfig.EMULATOR_HOST
                FirebaseAuth.getInstance(app).useEmulator(host, PORT_AUTH)
                firestore.useEmulator(host, PORT_FIRESTORE)
                FirebaseStorage.getInstance(app).useEmulator(host, PORT_STORAGE)
                Log.i("HomeHub", "Using Firebase emulators at $host")
            } else {
                FirebaseAppCheck.getInstance().installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
            }
            firestore.firestoreSettings = FirebaseFirestoreSettings.Builder()
                .setLocalCacheSettings(PersistentCacheSettings.newBuilder().setSizeBytes(50L * 1024 * 1024).build())
                .build()
            done = true
        }
    }

    fun gatewayBaseUrl(): String = when {
        BuildConfig.GATEWAY_URL.isNotBlank() -> BuildConfig.GATEWAY_URL.trimEnd('/')
        usingEmulators -> "http://${BuildConfig.EMULATOR_HOST}:$PORT_FUNCTIONS/$PROJECT_ID_DEMO/$REGION/api"
        else -> "https://$REGION-${FirebaseApp.getInstance().options.projectId}.cloudfunctions.net/api"
    }
}
