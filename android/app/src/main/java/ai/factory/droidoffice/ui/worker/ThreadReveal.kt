package ai.factory.droidoffice.ui.worker

import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadLive
import ai.factory.droidoffice.core.ThreadWordReveal
import ai.factory.droidoffice.core.committedStream
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest

internal data class RevealedThreadText(val stream: ThreadLive.Stream, val after: String?, val entryId: String?, val text: String)

/** Only the live item and the canonical thought in flight subscribe to individual words. */
internal val LocalThreadReveal = staticCompositionLocalOf<State<RevealedThreadText?>?> { null }

private data class RevealInput(
    val stream: ThreadLive.Stream?,
    val after: String?,
    val at: Long?,
    val entries: List<ThreadEntry>,
)

@Composable
internal fun rememberThreadReveal(
    sessionId: String?,
    stream: ThreadLive.Stream?,
    after: String?,
    at: Long?,
    entries: List<ThreadEntry>,
): State<RevealedThreadText?> {
    val input by rememberUpdatedState(RevealInput(stream, after, at, entries))
    val shown = remember(sessionId) { mutableStateOf<RevealedThreadText?>(null) }
    LaunchedEffect(shown) {
        var reveal = ThreadWordReveal()
        var active: ThreadLive.Stream? = null
        var anchor: String? = null
        snapshotFlow { input }.collectLatest { current ->
            val next = current.stream
            val previous = active
            val newStream = next != null && (previous == null || previous.since != next.since || previous.kind != next.kind)
            if (newStream) {
                reveal = ThreadWordReveal()
                anchor = current.after
            }
            if (next != null) active = next
            val held = active ?: return@collectLatest
            val committed = if (next == null) committedStream(current.entries, anchor, held) else null
            val final = committed?.text
            val target = if (final != null) ThreadWordReveal.Target(final) else ThreadWordReveal.Target(held.text, held.length)
            reveal.accept(
                target,
                now = SystemClock.uptimeMillis(),
                join = newStream && current.at?.let { it - held.since > ThreadWordReveal.JOIN_AGE_MS } == true,
                ended = next == null,
            )
            fun paint(text: String) {
                shown.value = RevealedThreadText(held, anchor, committed?.id, text)
            }
            paint(reveal.visible)
            while (reveal.pending) {
                withFrameNanos { }
                paint(reveal.tick(SystemClock.uptimeMillis()))
            }
            if (next == null) {
                // Live often clears before the session page arrives. Hold its last frame briefly,
                // then hand off immediately once the canonical entry has finished revealing.
                if (committed == null) delay(450)
                shown.value = null
                active = null
            }
        }
    }
    return shown
}
