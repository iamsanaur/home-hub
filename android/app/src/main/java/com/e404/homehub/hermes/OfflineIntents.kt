package com.e404.homehub.hermes

/**
 * A handful of common commands handled entirely on the phone with no model call — the cheapest
 * possible path for battery, and the only path while offline. Anything else goes to the agent.
 */
sealed interface OfflineIntent {
    data class AddToList(val item: String, val quantity: Double, val unit: String) : OfflineIntent
    data class CompleteTask(val query: String) : OfflineIntent
    data object DueToday : OfflineIntent
    data class AddTask(val title: String) : OfflineIntent
}

object OfflineIntents {
    private val add = Regex("^(?:please\\s+)?(?:add|buy|get)\\s+(?:(\\d+(?:\\.\\d+)?)\\s*(kg|g|l|ml|pcs|packs?|dozen|bunch(?:es)?)?\\s+(?:of\\s+)?)?(.+?)(?:\\s+(?:to|on)\\s+(?:the\\s+|my\\s+)?(?:shopping|grocery)?\\s*list)?\\.?$", RegexOption.IGNORE_CASE)
    private val done = Regex("^(?:mark|set)\\s+(.+?)\\s+(?:as\\s+)?(?:done|complete|completed)\\.?$|^(?:i\\s+)?(?:finished|completed|did)\\s+(.+?)\\.?$", RegexOption.IGNORE_CASE)
    private val due = Regex("^(?:what(?:'s| is)\\s+(?:due|on)\\s+today|today'?s tasks|what do i have today)\\??$", RegexOption.IGNORE_CASE)
    private val remind = Regex("^(?:remind me to|add (?:a )?task(?: to)?:?)\\s+(.+?)\\.?$", RegexOption.IGNORE_CASE)

    fun parse(input: String): OfflineIntent? {
        val s = input.trim()
        if (due.matches(s)) return OfflineIntent.DueToday
        remind.find(s)?.let { return OfflineIntent.AddTask(it.groupValues[1].trim().replaceFirstChar { c -> c.uppercase() }) }
        done.find(s)?.let { m -> val q = m.groupValues[1].ifBlank { m.groupValues[2] }.removePrefix("the ").trim(); if (q.isNotBlank()) return OfflineIntent.CompleteTask(q) }
        add.find(s)?.let { m ->
            val item = m.groupValues[3].trim().removePrefix("some ").trim()
            // Too long / clause-like → not a simple list add; let the agent handle it.
            if (item.isBlank() || item.split(" ").size > 4 || item.contains(" and ") || item.contains(",")) return null
            val unit = m.groupValues[2].lowercase().ifBlank { "pcs" }.let { if (it.startsWith("pack")) "pack" else if (it.startsWith("bunch")) "bunch" else it }
            return OfflineIntent.AddToList(item.replaceFirstChar { it.uppercase() }, m.groupValues[1].toDoubleOrNull() ?: 1.0, unit)
        }
        return null
    }
}
