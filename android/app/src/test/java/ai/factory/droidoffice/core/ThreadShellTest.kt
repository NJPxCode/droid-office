package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadScrollTest {
    @Test
    fun onlyScrollingTowardHistoryUnpinsAndReturningToTailFollowsAgain() {
        assertTrue(ThreadScroll.afterDrag(following = true, dy = 0f, away = true))
        assertTrue(ThreadScroll.afterDrag(following = true, dy = -5f, away = true))
        assertFalse(ThreadScroll.afterDrag(following = true, dy = 2f, away = true))
        assertTrue(ThreadScroll.afterDrag(following = true, dy = 2f, away = false))
        assertFalse(ThreadScroll.afterDrag(following = false, dy = -2f, away = true))
        assertTrue(ThreadScroll.afterDrag(following = false, dy = -2f, away = false))
    }

    @Test
    fun theButtonShowsOnlyWhenNotFollowingAndAwayFromTheTail() {
        assertFalse(ThreadScroll.showJump(following = true, away = true))
        assertFalse(ThreadScroll.showJump(following = false, away = false))
        assertTrue(ThreadScroll.showJump(following = false, away = true))
    }

    @Test
    fun earlierPagesKeepTheSameLazyIndexesForTheNewestRows() {
        assertEquals(1, ThreadScroll.indexOf(100, 99))
        assertEquals(1, ThreadScroll.indexOf(170, 169))
        assertEquals(100, ThreadScroll.indexOf(100, 0))
        assertEquals(100, ThreadScroll.indexOf(170, 70))
        assertEquals(null, ThreadScroll.indexOf(170, -1))
    }

    @Test
    fun visibleHeadOnlyAutoPagesWhileReadingEarlier() {
        assertFalse(ThreadScroll.autoPage(following = true, searchScroll = false, headVisible = true))
        assertFalse(ThreadScroll.autoPage(following = false, searchScroll = true, headVisible = true))
        assertFalse(ThreadScroll.autoPage(following = false, searchScroll = false, headVisible = false))
        assertTrue(ThreadScroll.autoPage(following = false, searchScroll = false, headVisible = true))
    }
}

class ThreadStatusTest {
    private val working = WorkerInfo(id = "w", status = "working")
    private val live = ThreadLive(rev = 1, at = 0, status = ThreadLive.Status.Pondering, working = "executing_tool", phaseSince = 80_000)
    private val tool = ThreadLive.Tool("tool:1", "Execute", 57_000, "running")
    private val entry = ThreadEntry("tool:1", 1, ThreadRole.Assistant, ThreadKind.Tool, input = """{"command":"npm test"}""")

    @Test
    fun reportsLiveCommandAndElapsedClockWithSkew() {
        val running = live.copy(tools = listOf(tool))
        val line = ThreadStatus.line(working, running, listOf(entry), 1000)!!
        assertEquals("Running: npm test", line.label)
        assertEquals("42s", ThreadStatus.elapsed(line.since!!, 100_000))
        assertEquals("Running: Execute", ThreadStatus.line(working, running, emptyList(), 0)?.label)
        assertEquals("1m 2s", ThreadStatus.elapsed(0, 62_000))
    }

    @Test
    fun reportsCurrentPhaseNotRecordedOutput() {
        assertEquals("Thinking", ThreadStatus.line(working, live.copy(working = "thinking"), emptyList(), 0)?.label)
        assertEquals("Writing", ThreadStatus.line(working, live.copy(status = ThreadLive.Status.Responding), emptyList(), 0)?.label)
        assertEquals("Working…", ThreadStatus.line(working, null, listOf(entry), 0)?.label)
        assertEquals("Starting worker…", ThreadStatus.line(working.copy(status = "starting"), live, emptyList(), 0)?.label)
        assertEquals(null, ThreadStatus.line(working.copy(status = "idle"), live, emptyList(), 0))
    }

    @Test
    fun distinguishesPermissionAndQuestionFromActiveTools() {
        val running = live.copy(tools = listOf(tool))
        val permission = ThreadStatus.line(working.copy(status = "needs_input"), running.copy(working = "waiting_for_tool_confirmation"), emptyList(), 0)
        assertEquals(ThreadStatus.Line("Waiting for you: permission needed", waiting = true), permission)
        val question = ThreadStatus.line(working, running.copy(status = ThreadLive.Status.Waiting, waiting = ThreadLive.Waiting("question")), emptyList(), 0)
        assertEquals(ThreadStatus.Line("Waiting for you: answer needed", waiting = true), question)
    }
}

class ThreadLiveTest {
    @Test
    fun appendsOnlyToMatchingSessionRevisionAndUtf16Length() {
        val state = ThreadLiveState()
        val text = "x".repeat(39_999) + "🚀" + " tail"
        val live = ThreadLive.of(OfficeJson.parseToJsonElement(
            """{"rev":5,"at":0,"status":"responding","stream":{"kind":"text","text":"$text"},"tools":[{"name":"Execute","output":"$text"}]}""",
        ))!!
        val patch = ServerMsg.ThreadStream("w", "s", 7, 5, text.length, " and new")
        assertEquals(ThreadLiveState.Append.Resync, state.append(patch))
        assertTrue(state.receive("s", live))
        assertEquals(40_000, live.stream?.text?.length)
        assertTrue(live.tools.single().output!!.endsWith("🚀 tail"))
        assertEquals(ThreadLiveState.Append.Resync, state.append(patch.copy(base = 6)))
        assertEquals(ThreadLiveState.Append.Resync, state.append(patch.copy(from = text.length - 1)))
        assertEquals(ThreadLiveState.Append.Resync, state.append(patch.copy(sessionId = "other")))
        assertEquals(ThreadLiveState.Append.Applied, state.append(patch))
        assertEquals(7L, state.live?.rev)
        assertTrue(state.live?.stream?.text?.endsWith(" tail and new") == true)
        assertEquals(text.length + patch.text.length, state.live?.stream?.length)
        assertEquals(ThreadLiveState.Append.Ignore, state.append(patch))
        assertTrue(state.receive("s", live.copy(rev = 8, stream = null)))
        assertEquals(ThreadLiveState.Append.Resync, state.append(patch.copy(base = 8, rev = 9)))
    }

    @Test
    fun liveUpdatesMustMatchTheWorkersCurrentSessionEvenWhenMissing() {
        val state = ThreadLiveState()
        val live = ThreadLive(rev = 5, at = 0, status = ThreadLive.Status.Pondering, working = "thinking")
        assertTrue(state.receive("s1", live, expectedSession = "s1"))
        assertFalse(state.receive(null, live.copy(rev = 6), expectedSession = "s1"))
        assertFalse(state.receive("old", live.copy(rev = 99), expectedSession = "s1"))
        assertFalse(state.receive("s1", live.copy(rev = 99), expectedSession = "s2"))
        assertEquals("s1", state.session)
        assertEquals(5L, state.live?.rev)
        // New sessions can restart revisions on an older office; stale-session rejection is separate.
        assertTrue(state.receive("s2", live.copy(rev = 1), expectedSession = "s2"))
        assertFalse(state.receive("s1", live.copy(rev = 100), expectedSession = "s2"))
        assertFalse(state.receive("s2", live.copy(rev = 2), expectedSession = null))
        assertTrue(state.receive(null, live.copy(rev = 1), expectedSession = null))
        assertEquals(null, state.session)
    }

    @Test
    fun readsTheOfficesLiveTurn() {
        val json = """{"rev":4,"at":1000,"status":"pondering","working":"executing_tool","label":"Planning 8 actions","turnStartedAt":900,"phaseSince":950,
            "after":"e9","stream":{"kind":"thinking","text":"Hmm","since":960},
            "tools":[{"id":"tool:a","name":"Execute","startedAt":970,"phase":"running","output":"ok\n","more":3},{"phase":"running"}],
            "waiting":{"kind":"permission","toolId":"tool:a"},
            "settings":{"model":"claude-opus-5-5","modelName":"Opus 5.5","reasoningEffort":"high","interactionMode":"spec","autonomyLevel":"medium"}}"""
        val live = ThreadLive.of(OfficeJson.parseToJsonElement(json))!!
        assertEquals(4L, live.rev)
        assertEquals(ThreadLive.Status.Pondering, live.status)
        assertEquals("Planning 8 actions", live.label)
        assertEquals(ThreadLive.Stream("thinking", "Hmm", 960), live.stream)
        assertEquals(1, live.tools.size)
        assertEquals(3, live.tools.single().more)
        assertEquals(ThreadLive.Waiting("permission", "tool:a"), live.waiting)
        val s = live.settings!!
        assertEquals("spec", s.interactionMode)
        assertEquals("Opus 5.5", s.modelName)
    }

    @Test
    fun skipsWhatItCantReadAndKeepsTheNewestRev() {
        assertEquals(null, ThreadLive.of(OfficeJson.parseToJsonElement("""{"rev":1,"at":2,"status":"dancing"}""")))
        assertEquals(null, ThreadLive.of(OfficeJson.parseToJsonElement("""{"at":2,"status":"idle"}""")))
        val state = ThreadLiveState()
        val a = ThreadLive(rev = 5, at = 0, status = ThreadLive.Status.Pondering, working = "thinking")
        assertTrue(state.receive("s1", a))
        assertFalse(state.receive("s1", a.copy(rev = 5, status = ThreadLive.Status.Idle)))
        assertFalse(state.receive("s1", a.copy(rev = 4)))
        assertTrue(state.receive("s1", a.copy(rev = 6)))
        // A new session starts its revs over.
        assertTrue(state.receive("s2", a.copy(rev = 1)))
        assertEquals("s2", state.session)
    }

    @Test
    fun entriesCarryTheirTimes() {
        val e = ThreadEntry.of(OfficeJson.parseToJsonElement("""{"id":"t1","seq":3,"role":"assistant","kind":"thinking","text":"x","at":1700000000000,"tookMs":4200,"child":"c1"}"""))!!
        assertEquals(1_700_000_000_000L, e.at)
        assertEquals(4200L, e.tookMs)
        assertEquals("c1", e.child)
        assertEquals(null, e.doneAt)
    }

    @Test
    fun snapshotPreservesLongRepliesThoughtsAndToolTails() {
        val full = "A line of prose that should stay intact.\n".repeat(1600) + "END-OF-REPLY-SENTINEL"
        assertTrue(full.length > 60_000)
        for (kind in listOf("text", "thinking")) {
            val entry = ThreadEntry.of(buildJsonObject {
                put("id", JsonPrimitive("long"))
                put("seq", JsonPrimitive(1))
                put("role", JsonPrimitive("assistant"))
                put("kind", JsonPrimitive(kind))
                put("text", JsonPrimitive(full))
            })
            assertEquals(full, entry?.text)
        }
        val tool = ThreadEntry.of(OfficeJson.parseToJsonElement(
            """{"id":"tool:call","seq":2,"role":"assistant","kind":"tool","output":"[2250 earlier lines hidden]\nFINAL-OUTPUT-LINE","outputRef":"140.0.0123456789abcdef0123456789abcdef"}""",
        ))!!
        assertEquals("140.0.0123456789abcdef0123456789abcdef", tool.outputRef)
        assertEquals("[2250 earlier lines hidden]\nFINAL-OUTPUT-LINE", ThreadView.outputText(tool, pictures = false))
    }
}
