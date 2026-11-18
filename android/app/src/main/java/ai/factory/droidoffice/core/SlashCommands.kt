package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable

/**
 * Droid's slash commands and what the Thread view does with each, as on the web
 * (src/shared/slash-commands.ts; tests/slash-commands.test.ts keeps the built-in lists equal).
 * Built-in commands run natively in the Thread or via daemon RPCs; ending the CLI is refused
 * (Send home is how a worker leaves). The worker's skills and custom commands come from its
 * droid (GET /api/agents/droid/commands?worker=) and run as prompts. [Command.midTurn] marks
 * the ones that can be invoked while a turn is running.
 */
object SlashCommands {
    enum class Kind { Thread, Blocked }

    /** Where a command that isn't built in comes from. */
    enum class Source { Skill, Command }

    data class Command(
        val name: String,
        val description: String,
        val kind: Kind,
        val aliases: List<String> = emptyList(),
        /** Runs during an active turn instead of requiring the turn to stop first. */
        val midTurn: Boolean = false,
        val source: Source? = null,
        val argumentHint: String? = null,
    )

    val ALL = listOf(
        Command("compress", "Compress the session in place. Add instructions to shape the summary", Kind.Thread, listOf("compact")),
        Command("clear", "Clear the conversation, keeping the model", Kind.Thread),
        Command("new", "Start a fresh session with the default model", Kind.Thread),
        Command("handoff", "Start a new session with a summary of this one", Kind.Thread),
        Command("copy", "Copy a reply, a prompt, a range of turns, the transcript or the session id", Kind.Thread, midTurn = true),
        Command("limits", "Manage credit limits and overage", Kind.Thread, midTurn = true),
        Command("quit", "Ends this worker’s Droid. Use Send home instead", Kind.Blocked, listOf("exit")),
    )

    /**
     * Every slash command a worker offers: the built-in ones, then its droid's custom commands and
     * skills. One named like a built-in command (or its alias) is left out, since Droid runs the built-in.
     */
    fun all(live: List<DroidCommand>): List<Command> {
        val taken = ALL.flatMap { listOf(it.name) + it.aliases }.toMutableSet()
        val extra = live.mapNotNull { c ->
            val source = when (c.source) {
                "skill" -> Source.Skill
                "command" -> Source.Command
                else -> return@mapNotNull null
            }
            if (c.name.isBlank() || !taken.add(c.name.lowercase())) return@mapNotNull null
            Command(c.name, c.description, Kind.Thread, source = source, argumentHint = c.argumentHint?.takeIf { it.isNotBlank() })
        }
        return ALL + extra
    }

    private val NAME = Regex("""^/([^\s/]*)(?=\s|$)""")
    private val TYPING = Regex("""^/([^\s/]*)$""")

    /** The name a draft starting with `/` asks for, and the command when Droid has it built in; null for a plain message. */
    fun of(draft: String, commands: List<Command> = ALL): Pair<String, Command?>? {
        val name = NAME.find(draft.trimStart())?.groupValues?.get(1)?.lowercase() ?: return null
        return name to commands.firstOrNull { it.name.lowercase() == name || name in it.aliases }
    }

    /** What sending [draft] does: run in the thread, or nothing when blocked. A plain message is [Kind.Thread]. */
    fun kind(draft: String): Kind = of(draft)?.second?.kind ?: Kind.Thread

    /** `/copy` (optionally with a turn count like `/copy 3`) opens the Thread's own copy dialog. */
    fun nativeCopy(draft: String): Boolean = of(draft)?.second?.name == "copy"

    /** Optional positive turn count passed to `/copy <n>`, defaulting to `"1"`. */
    fun copyTurns(draft: String): String =
        draft.trim().substringAfter(' ', "").trim().filter(Char::isDigit).take(4).ifEmpty { "1" }

    /**
     * Why a slash draft can't be sent now, or null when it can: a command that would end the session never,
     * and while a turn runs only those allowed mid-turn ([Command.midTurn]).
     */
    fun refusal(draft: String, name: String, busy: Boolean, commands: List<Command> = ALL): String? {
        val (typed, command) = of(draft, commands) ?: return null
        if (command?.kind == Kind.Blocked) return "/$typed would end $name’s Droid. Send it home instead."
        if (busy && command?.midTurn != true) return "/$typed runs once $name finishes this turn. Stop it to run it now."
        return null
    }

    /** A connected Factory account opens the office sheet, even when limits are unreadable or not applicable. */
    fun nativeLimits(draft: String, connected: Boolean): Boolean = connected && of(draft)?.second?.name == "limits"

    /** The commands to offer while a `/` and the start of a name are typed: prefix matches, then aliases, then names containing it. */
    fun suggestions(draft: String, commands: List<Command> = ALL): List<Command> {
        val typed = TYPING.find(draft.trimStart())?.groupValues?.get(1)?.lowercase() ?: return emptyList()
        fun rank(c: Command) = c.name.lowercase().let { name ->
            when {
                name.startsWith(typed) -> 0
                c.aliases.any { it.startsWith(typed) } -> 1
                typed in name -> 2
                else -> -1
            }
        }
        return commands.withIndex().map { Triple(it.value, rank(it.value), it.index) }
            .filter { it.second >= 0 }
            .sortedWith(compareBy({ it.second }, { it.third }))
            .map { it.first }
    }
}

/** A skill or custom command a worker's droid offers, as GET /api/agents/droid/commands lists it. */
@Serializable
data class DroidCommand(val name: String, val description: String = "", val source: String = "", val argumentHint: String? = null)

@Serializable
data class DroidCommands(val commands: List<DroidCommand> = emptyList())
