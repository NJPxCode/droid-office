package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SlashCommandsTest {
    @Test
    fun slashDraftsAreToldApartFromMessages() {
        assertEquals("compress", SlashCommands.of("/compress")?.first)
        assertEquals("handoff", SlashCommands.of("  /handoff keep context")?.first)
        assertNull(SlashCommands.of("look at /etc/hosts"))
        assertNull(SlashCommands.of("/etc/hosts is wrong"))
        assertNull(SlashCommands.of(""))
    }

    @Test
    fun exactBuiltInDaemonCommandsAndBlockedExit() {
        assertEquals(
            listOf("compress", "clear", "new", "handoff", "copy", "limits", "quit"),
            SlashCommands.ALL.map { it.name },
        )
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/compress"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/compact keep the plan"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/clear"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/new"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/handoff summarize progress"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/copy"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/limits"))
        assertEquals(SlashCommands.Kind.Blocked, SlashCommands.kind("/quit"))
        assertEquals(SlashCommands.Kind.Blocked, SlashCommands.kind("/exit"))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("hello"))
    }

    @Test
    fun allTuiDialogVimAndSideChatSlashCommandsAreDropped() {
        val dropped = listOf(
            // 32 TUI-dialog commands + /vim + /btw + /side + legacy TUI commands
            "model", "settings", "tree", "rewind-conversation", "sessions", "share", "review",
            "missions", "create-skill", "mcp", "connectors", "plugins", "skills", "droids",
            "hooks", "commands", "diagnostics", "ide", "bug", "install-slack-app",
            "setup-incident-response", "statusline", "themes", "language", "terminal-setup",
            "cd", "cwd", "account", "billing", "login", "logout", "install-code-review",
            "vim", "btw", "side", "fast", "favorite", "archive", "status", "context", "rename", "fork", "stats", "cost", "help",
        )
        for (name in dropped) {
            assertNull("Expected /$name to be dropped from built-ins", SlashCommands.of("/$name")?.second)
        }
    }

    @Test
    fun nativeCopyAndLimitsHelpers() {
        assertTrue(SlashCommands.nativeCopy(" /copy "))
        assertTrue(SlashCommands.nativeCopy("/copy 3"))
        assertEquals("1", SlashCommands.copyTurns("/copy"))
        assertEquals("3", SlashCommands.copyTurns("/copy 3"))
        assertFalse(SlashCommands.nativeCopy("/copy-other"))

        assertTrue(SlashCommands.nativeLimits(" /LIMITS ", true))
        assertFalse(SlashCommands.nativeLimits("/limits", false))
        assertFalse(SlashCommands.nativeLimits("/limits-other", true))
        assertFalse(SlashCommands.nativeLimits("show /limits", true))
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/limits"))
    }

    @Test
    fun theWorkersSkillsAndCommandsFollowTheBuiltInOnes() {
        val all = SlashCommands.all(
            listOf(
                DroidCommand("deploy", "Custom command: deploy", "command"),
                DroidCommand("Compact", "A skill named like an alias", "skill"),
                DroidCommand("clear", "A skill named like a built-in", "skill"),
                DroidCommand("security-review", "Security-focused code review", "skill", "[path]"),
                DroidCommand("review", "Workspace review skill", "skill"),
                DroidCommand("odd", "From an unknown place", "plugin"),
            ),
        )
        assertEquals(SlashCommands.ALL, all.take(SlashCommands.ALL.size))
        assertEquals(
            listOf(
                SlashCommands.Command("deploy", "Custom command: deploy", SlashCommands.Kind.Thread, source = SlashCommands.Source.Command),
                SlashCommands.Command("security-review", "Security-focused code review", SlashCommands.Kind.Thread, source = SlashCommands.Source.Skill, argumentHint = "[path]"),
                SlashCommands.Command("review", "Workspace review skill", SlashCommands.Kind.Thread, source = SlashCommands.Source.Skill),
            ),
            all.drop(SlashCommands.ALL.size),
        )
        assertEquals(SlashCommands.Source.Skill, SlashCommands.of("/Security-Review the diff", all)?.second?.source)
        assertNull(SlashCommands.of("/security-review")?.second)
        assertEquals(listOf("review", "security-review"), SlashCommands.suggestions("/rev", all).map { it.name })
        assertEquals(SlashCommands.Kind.Thread, SlashCommands.kind("/security-review"))
        assertEquals(all, SlashCommands.suggestions("/", all))
    }

    @Test
    fun theOfficeListDecodes() {
        val json = """{"commands":[{"name":"review","description":"Custom command: review","source":"command"},{"name":"security-review","description":"Review","source":"skill","argumentHint":"[path]","extra":1}]}"""
        val parsed = OfficeJson.decodeFromString<DroidCommands>(json).commands
        assertEquals(listOf(DroidCommand("review", "Custom command: review", "command"), DroidCommand("security-review", "Review", "skill", "[path]")), parsed)
    }

    @Test
    fun suggestionsOnlyWhileTypingAName() {
        assertEquals(listOf("compress", "copy"), SlashCommands.suggestions("/co").map { it.name })
        assertEquals(listOf("compress"), SlashCommands.suggestions("/comp").map { it.name })
        assertEquals(listOf("handoff"), SlashCommands.suggestions("/ha").map { it.name })
        assertEquals(SlashCommands.ALL, SlashCommands.suggestions("/"))
        assertEquals(emptyList<String>(), SlashCommands.suggestions("/compress ").map { it.name })
        assertEquals(emptyList<String>(), SlashCommands.suggestions("hi /co").map { it.name })
    }

    @Test
    fun midTurnOnlyCopyAndLimitsRunAndExitNeverDoes() {
        assertNull(SlashCommands.refusal("hello", "Atlas", busy = true))
        assertNull(SlashCommands.refusal("/handoff", "Atlas", busy = false))
        assertNull(SlashCommands.refusal("/copy", "Atlas", busy = true))
        assertNull(SlashCommands.refusal("/limits", "Atlas", busy = true))
        assertEquals("/exit would end Atlas’s Droid. Send it home instead.", SlashCommands.refusal("/exit", "Atlas", busy = false))
        assertEquals("/quit would end Atlas’s Droid. Send it home instead.", SlashCommands.refusal("/quit", "Atlas", busy = true))
        assertEquals("/compact runs once Atlas finishes this turn. Stop it to run it now.", SlashCommands.refusal("/compact", "Atlas", busy = true))
        assertEquals("/handoff runs once Atlas finishes this turn. Stop it to run it now.", SlashCommands.refusal("/handoff", "Atlas", busy = true))
        assertEquals("/unknown runs once Atlas finishes this turn. Stop it to run it now.", SlashCommands.refusal("/unknown", "Atlas", busy = true))
    }
}
