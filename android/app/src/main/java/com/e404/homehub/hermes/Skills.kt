package com.e404.homehub.hermes

/**
 * Hermes skills on the phone: the exact SKILL.md files from agents/hermes/skills (bundled as
 * app assets at build time). Progressive loading, as in Hermes: the system prompt carries only
 * names + one-line descriptions; the full procedure is loaded by the `skill_view` tool.
 */
data class Skill(val name: String, val description: String, val body: String)

class SkillRegistry(private val skills: Map<String, Skill>) {
    val names: Set<String> get() = skills.keys

    fun index(): String = skills.values.sortedBy { it.name }.joinToString("\n") { "- ${it.name}: ${it.description}" }

    fun view(name: String): String? = skills[name]?.body

    companion object {
        /** Parses SKILL.md frontmatter (name, description) and body. */
        fun parse(text: String): Skill? {
            if (!text.startsWith("---")) return null
            val end = text.indexOf("\n---", 3).takeIf { it > 0 } ?: return null
            val front = text.substring(3, end)
            fun field(k: String) = Regex("^$k:\\s*(.+)$", RegexOption.MULTILINE).find(front)?.groupValues?.get(1)?.trim()?.trim('"')
            val name = field("name") ?: return null
            return Skill(name, field("description") ?: "", text.substring(end + 4).trim())
        }

        fun fromTexts(texts: List<String>) = SkillRegistry(texts.mapNotNull(::parse).associateBy { it.name })
    }
}
