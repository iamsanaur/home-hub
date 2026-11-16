package com.e404.homehub.hermes

/**
 * Battery policy for Hermes Mobile. The expensive parts of an agent run on a phone are the
 * radio (each model/tool round trip) and wall-clock time with the CPU awake, so the policy
 * limits round trips, keeps the screen-on (foreground) path snappy, and pushes optional work
 * to times when the phone is charging.
 */
enum class PowerMode { Normal, Saver, Critical }

data class PowerSnapshot(
    val levelPercent: Int?,
    val charging: Boolean,
    val powerSaver: Boolean,
    /** 0 = none … 6 = shutdown (Android PowerManager thermal status scale; iOS mapped onto it). */
    val thermal: Int,
    val unmetered: Boolean,
) {
    val mode: PowerMode get() = when {
        !charging && (levelPercent ?: 100) <= 5 -> PowerMode.Critical
        thermal >= 4 -> PowerMode.Critical            // severe+ heat: stop optional work
        !charging && (powerSaver || (levelPercent ?: 100) <= 20 || thermal >= 2) -> PowerMode.Saver
        else -> PowerMode.Normal
    }

    /** Scheduled/background agent work: only while charging, cool, and on unmetered network. */
    val allowsBackgroundAgent: Boolean get() = charging && thermal < 2 && unmetered

    /** A person explicitly asked: run unless the phone is critically low or overheating. */
    val allowsForegroundAgent: Boolean get() = mode != PowerMode.Critical
}

fun interface PowerSource { fun snapshot(): PowerSnapshot }
