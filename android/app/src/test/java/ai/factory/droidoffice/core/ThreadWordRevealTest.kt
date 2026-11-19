package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadWordRevealTest {
    @Test
    fun showsWholeWordsOnSeparatePaintsAndLetsAPartialWordFinish() {
        val reveal = ThreadWordReveal()
        reveal.accept(ThreadWordReveal.Target("First second th"), now = 0)
        assertEquals("First ", reveal.tick(0))
        assertEquals("First ", reveal.tick(16))
        assertEquals("First second ", reveal.tick(40))
        assertEquals("First second ", reveal.tick(100))
        reveal.accept(ThreadWordReveal.Target("First second third"), now = 105)
        assertEquals("First second ", reveal.tick(200))
        assertEquals("First second third", reveal.tick(235))
        assertFalse(reveal.pending)
    }

    @Test
    fun aLargeBurstRollsOutThenFinishesWithinOneSecond() {
        val reveal = ThreadWordReveal()
        val text = "one two three four five ".repeat(300)
        reveal.accept(ThreadWordReveal.Target(text), now = 0)
        assertTrue(reveal.tick(16).length in 1 until text.length / 2)
        reveal.accept(ThreadWordReveal.Target(text), now = 32, ended = true)
        val paints = (32..992 step 16).map { reveal.tick(it.toLong()) }
        assertTrue(paints.distinct().size >= 8)
        assertEquals(text, paints.last())
    }

    @Test
    fun joiningKeepsExistingTextAndASlidingTailDoesNotReplayIt() {
        val reveal = ThreadWordReveal()
        reveal.accept(ThreadWordReveal.Target("first second "), now = 0, join = true)
        assertEquals("first second ", reveal.visible)
        reveal.accept(ThreadWordReveal.Target("second third ", length = "first second third ".length), now = 10)
        assertEquals("second ", reveal.visible)
        assertEquals("second third ", reveal.tick(50))
    }

    @Test
    fun matchesOnlyTheCanonicalAssistantEntryInTheSameTurn() {
        val thought = ThreadLive.Stream("thinking", "I will ", 0)
        val user = ThreadEntry("u", 1, ThreadRole.User, ThreadKind.Text, "Please check")
        val reply = ThreadEntry("a", 2, ThreadRole.Assistant, ThreadKind.Text, "I will check.")
        val savedThought = reply.copy(id = "t", kind = ThreadKind.Thinking)
        assertEquals(savedThought, committedStream(listOf(user, reply, savedThought), "u", thought))
        assertNull(committedStream(listOf(user, reply, user.copy(id = "u2"), savedThought), "u", thought))
        assertNull(committedStream(listOf(savedThought), "missing", thought))
    }
}
