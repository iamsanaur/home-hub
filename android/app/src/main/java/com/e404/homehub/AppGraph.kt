package com.e404.homehub

import android.content.Context
import com.e404.homehub.data.local.HomeHubDatabase
import com.e404.homehub.data.remote.FirebaseBootstrap
import com.e404.homehub.data.remote.GatewayClient
import com.e404.homehub.data.repo.AgentRepository
import com.e404.homehub.data.repo.HouseholdDataRepository
import com.e404.homehub.data.repo.OfflineRepository
import com.e404.homehub.data.repo.SessionRepository
import com.e404.homehub.data.sync.SyncEngine
import com.e404.homehub.hermes.HermesMobile
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Minimal manual DI: one place that constructs the app's long-lived objects. */
class AppGraph private constructor(context: Context) {
    val appContext: Context = context.applicationContext
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    init { FirebaseBootstrap.init(appContext) }

    val auth: FirebaseAuth = FirebaseAuth.getInstance()
    val firestore: FirebaseFirestore = FirebaseFirestore.getInstance()
    val database = HomeHubDatabase.get(appContext)
    val gateway = GatewayClient(baseUrl = FirebaseBootstrap::gatewayBaseUrl, useAppCheck = { !FirebaseBootstrap.usingEmulators })
    val session = SessionRepository(auth, firestore, gateway, database.dao())
    val offline = OfflineRepository(appContext, firestore, database.dao(), scope)
    val data = HouseholdDataRepository(firestore) { auth.currentUser?.uid }
    val agent = AgentRepository(firestore, gateway)
    val connect = com.e404.homehub.data.repo.ConnectRepository(gateway)
    val syncEngine = SyncEngine(firestore, database.dao(), { auth.currentUser?.uid })
    /** Hermes Mobile — the on-device agent runtime. Skills are the same SKILL.md files the server Hermes uses. */
    val hermes by lazy { HermesMobile(appContext, gateway, HermesMobile.loadSkills(appContext)) }

    companion object {
        @Volatile private var instance: AppGraph? = null
        fun get(context: Context): AppGraph = instance ?: synchronized(this) { instance ?: AppGraph(context).also { instance = it } }
    }
}
