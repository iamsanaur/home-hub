package com.e404.homehub.ui

import android.app.Application
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.e404.homehub.AppGraph
import com.e404.homehub.data.model.Household
import com.e404.homehub.data.model.Member
import com.e404.homehub.data.model.Role
import com.e404.homehub.data.repo.UserProfile
import com.e404.homehub.notifications.DeviceId
import com.e404.homehub.ui.util.Dates
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.ZoneId

/** Everything a household screen needs to know about "where am I and who am I". */
@Immutable
data class HouseholdContext(
    val hid: String,
    val uid: String,
    val role: Role,
    val household: Household,
    val members: List<Member>,
) {
    val zone: ZoneId get() = Dates.zone(household.timezone)
    val currency: String get() = household.currency
    val me: Member? get() = members.firstOrNull { it.uid == uid }
    val canFinance: Boolean get() = role.isAdultPlus && (me?.financeAllowed ?: true)
    fun nameOf(uid: String?): String? = uid?.let { u -> members.firstOrNull { it.uid == u }?.displayName?.substringBefore(' ') }
}

val LocalHousehold = staticCompositionLocalOf<HouseholdContext> { error("No household in scope") }

sealed interface Gate {
    data object Loading : Gate
    data object SignedOut : Gate
    data class Onboarding(val uid: String, val profile: UserProfile?) : Gate
    data class Ready(val ctx: HouseholdContext, val profile: UserProfile) : Gate
}

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModel(app: Application) : AndroidViewModel(app) {
    val graph = AppGraph.get(app)
    private var attachedFor: String? = null

    val gate: StateFlow<Gate> = graph.session.authState().flatMapLatest { user ->
        if (user == null) flowOf(Gate.SignedOut)
        else graph.session.profile(user.uid).flatMapLatest { profile ->
            val hid = profile?.activeHouseholdId?.takeIf { profile.memberships.containsKey(it) || profile.onboardingCompleted }
            if (profile == null) flowOf(Gate.Loading)
            else if (hid == null || !profile.onboardingCompleted) flowOf(Gate.Onboarding(user.uid, profile))
            else combine(graph.session.household(hid), graph.session.members(hid)) { h, members ->
                val me = members.firstOrNull { it.uid == user.uid }
                if (h == null || me == null) Gate.Onboarding(user.uid, profile)
                else Gate.Ready(HouseholdContext(hid, user.uid, me.role, h, members), profile)
            }
        }
    }.distinctUntilChanged().stateIn(viewModelScope, SharingStarted.Eagerly, Gate.Loading)

    init {
        viewModelScope.launch { graph.session.authState().filterNotNull().distinctUntilChangedBy { it.uid }.collect { graph.session.validateSession(it) } }
        viewModelScope.launch {
            gate.collect { g ->
                if (g is Gate.Ready) {
                    val key = "${g.ctx.hid}:${g.ctx.uid}:${g.ctx.role}"
                    if (key != attachedFor) {
                        attachedFor = key
                        graph.offline.attach(g.ctx.hid, g.ctx.uid, g.ctx.role)
                        registerPush()
                        // Scheduled agent jobs run on this phone only while charging + idle + unmetered.
                        if (g.ctx.role.isAdultPlus) com.e404.homehub.hermes.HermesJobWorker.schedule(getApplication(), g.ctx.hid)
                    }
                } else if (g is Gate.SignedOut) {
                    attachedFor = null; graph.offline.detach()
                }
            }
        }
    }

    val pendingSync: StateFlow<Int> = gate.flatMapLatest { g -> if (g is Gate.Ready) graph.offline.pendingCount(g.ctx.hid) else flowOf(0) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    val pendingApprovals: StateFlow<Int> = gate.flatMapLatest { g ->
        if (g is Gate.Ready && g.ctx.role.isAdultPlus) graph.agent.pendingApprovals(g.ctx.hid).map { it.size } else flowOf(0)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    private fun registerPush() {
        viewModelScope.launch {
            runCatching {
                val token = FirebaseMessaging.getInstance().token.await()
                graph.session.registerDevice(DeviceId.get(getApplication()), token, "1.0.0")
            } // Push is optional (no FCM on emulator-only builds); failures never block the app.
        }
    }

    fun switchHousehold(hid: String) {
        val uid = graph.session.currentUid ?: return
        viewModelScope.launch { graph.session.setActiveHousehold(uid, hid) }
    }

    fun signOut() {
        viewModelScope.launch { graph.session.signOut(DeviceId.get(getApplication())) }
    }
}
