package ai.factory.droidoffice.core

import kotlin.math.ceil

/** Paces thinking and reply text independently of the number of characters each wire frame carried. */
internal class ThreadWordReveal {
    data class Target(val text: String, val length: Int = text.length) {
        val start get() = length - text.length
    }

    private var target = Target("")
    private var end = 0
    private var lastPaint = Long.MIN_VALUE
    private var firstDue: Long? = null
    private var lastArrival = 0L
    private var finishBy: Long? = null
    val pending get() = end < target.length
    val visible get() = target.text.take((end - target.start).coerceIn(0, target.text.length))

    /** [now] is a monotonic clock. Joining an already running stream shows its existing text immediately. */
    fun accept(next: Target, now: Long, join: Boolean = false, ended: Boolean = false) {
        val overlapStart = maxOf(target.start, next.start)
        val overlapEnd = minOf(end, next.length)
        val rewritten = end > next.length || (overlapEnd > overlapStart && !target.text.regionMatches(
            overlapStart - target.start, next.text, overlapStart - next.start, overlapEnd - overlapStart,
        ))
        if (join || rewritten) end = next.length
        if (next != target) lastArrival = now
        end = maxOf(end, next.start)
        target = next
        if (pending && firstDue == null) firstDue = now + MAX_LAG_MS
        if (ended && finishBy == null) finishBy = now + FINISH_MS
    }

    fun tick(now: Long): String {
        if (!pending || (lastPaint != Long.MIN_VALUE && now - lastPaint < WORD_MS)) return visible
        val opening = end - target.start
        val text = target.text
        var whole = text.length
        if (finishBy == null && now - lastArrival < PARTIAL_WAIT_MS) {
            while (whole > opening && !text[whole - 1].isWhitespace()) whole--
        }
        if (opening >= whole) return visible
        val until = minOf(firstDue ?: now, finishBy ?: Long.MAX_VALUE) - now
        // One whole word per tick in ordinary streams; consume more only to drain a burst.
        val budget = maxOf(1, ceil((whole - opening) * WORD_MS.toDouble() / maxOf(WORD_MS, until)).toInt())
        var next = (opening + budget).coerceAtMost(whole)
        while (next < whole && !text[next - 1].isWhitespace() && !text[next].isWhitespace()) next++
        while (next < whole && text[next].isWhitespace()) next++
        end = target.start + next
        lastPaint = now
        if (!pending) firstDue = null
        return visible
    }

    companion object {
        const val JOIN_AGE_MS = 1_500L
        private const val WORD_MS = 36L
        private const val MAX_LAG_MS = 780L
        private const val FINISH_MS = 420L
        private const val PARTIAL_WAIT_MS = 130L
    }
}

/** Find the canonical copy of a stream without moving a partial reply to a different turn. */
internal fun committedStream(entries: List<ThreadEntry>, after: String?, stream: ThreadLive.Stream): ThreadEntry? {
    val anchor = if (after == null) -1 else entries.indexOfLast { it.id == after }.takeIf { it >= 0 } ?: return null
    val kind = if (stream.kind == "thinking") ThreadKind.Thinking else ThreadKind.Text
    val prefix = stream.text.trimEnd().takeIf { it.isNotEmpty() } ?: return null
    val offset = stream.length - stream.text.length
    for (i in anchor + 1 until entries.size) {
        val entry = entries[i]
        if (entry.role == ThreadRole.User) return null
        val text = entry.text ?: continue
        if (entry.role == ThreadRole.Assistant && entry.kind == kind &&
            text.regionMatches(offset, prefix, 0, prefix.length)
        ) return entry
    }
    return null
}
