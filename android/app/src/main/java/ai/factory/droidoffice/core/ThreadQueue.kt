package ai.factory.droidoffice.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

/**
 * The messages this phone sent to Droid's queue, held until the conversation shows them, paired with
 * the authoritative [WorkerQueueState] from `WorkerInfo.queue` (`src/shared/thread-queue.ts`).
 * Local receipts fill in full text or image markers when a server item is a cut-short preview, and
 * stand in briefly ([GRACE_MS]) before the next `worker.update` reflects a newly queued send.
 */
class ThreadQueue(saved: String? = null) {
    enum class Group(val wire: String) {
        Steering("steering"),
        Queued("queued"),
    }

    @Serializable
    data class Prompt(val id: Int, val text: String, val hasImage: Boolean, val after: Long, val at: Long = 0) {
        /** When [WorkerQueueState] last included this message. */
        @Transient var seen: Long = 0
    }

    /** One message waiting for its turn, as the thread shows it. [preview] when only a cut-short preview is known. */
    data class Shown(
        val key: String,
        val text: String,
        val hasImage: Boolean,
        val preview: Boolean,
        val more: Int,
        val id: String? = null,
        val serverIndex: Int? = null,
    )

    @Serializable
    private data class Saved(val session: String?, val sequence: Long, val items: List<Prompt>, val consumed: List<String>)
    private var session: String? = null
    private var serial = 0
    private val consumed = HashSet<String>()
    var sequence: Long = -1
        private set
    var pending: List<Prompt> = emptyList()
        private set

    init {
        val state = saved?.takeIf { it.length <= 800_000 }?.let { runCatching { OfficeJson.decodeFromString(Saved.serializer(), it) }.getOrNull() }
        if (state != null) {
            session = state.session
            sequence = state.sequence
            pending = state.items.takeLast(32).filter { it.id > 0 && it.text.length <= 20_000 }
            serial = pending.maxOfOrNull { it.id } ?: 0
            consumed += state.consumed.takeLast(2000)
        }
    }

    fun snapshot(): String = OfficeJson.encodeToString(Saved.serializer(), Saved(session, sequence, pending, consumed.toList()))

    fun sent(text: String, hasImage: Boolean, after: Long = sequence, at: Long = System.currentTimeMillis()) {
        pending = (pending + Prompt(++serial, text, hasImage, after, at)).takeLast(32)
    }

    /** Drops one local receipt when the user deletes or edits a queued message from the composer. */
    fun remove(text: String) {
        val idx = pending.indexOfFirst { it.text == text }
        if (idx >= 0) pending = pending.filterIndexed { i, _ -> i != idx }
        if (pending.isEmpty()) consumed.clear()
    }

    /** Forgets every message here, after Droid's queue was cleared. */
    fun clear() {
        pending = emptyList()
        consumed.clear()
    }

    fun sync(sessionId: String?, entries: List<ThreadEntry>): List<Prompt> {
        if (sessionId != null && session != null && sessionId != session) {
            pending = emptyList()
            consumed.clear()
            sequence = -1
        }
        if (sessionId != null) session = sessionId
        for (entry in entries) sequence = maxOf(sequence, entry.seq)
        for (entry in entries.sortedBy { it.seq }) {
            if (entry.role != ThreadRole.User || entry.id in consumed) continue
            var matched = false
            for (start in pending.indices) {
                if (matched) break
                var joined = ""
                for (end in start until pending.size) {
                    val item = pending[end]
                    if (entry.seq <= item.after) break
                    // Consecutive queued text sends can drain into one user message without a separator.
                    joined += item.text
                    val match = if (item.text.isNotEmpty()) entry.kind == ThreadKind.Text && entry.text?.trim() == joined
                    else start == end && item.hasImage &&
                        ((entry.kind == ThreadKind.Notice && entry.text == ThreadView.IMAGE_PLACEHOLDER) || (entry.kind == ThreadKind.Text && entry.text.isNullOrBlank() && entry.images.isNotEmpty()))
                    if (match) {
                        pending = pending.filterIndexed { index, _ -> index !in start..end }
                        consumed += entry.id
                        matched = true
                        break
                    }
                    if (item.text.isEmpty()) break
                }
            }
        }
        if (pending.isEmpty()) consumed.clear()
        return pending
    }

    /**
     * Queued messages waiting for their turn, oldest first. When [queuedItems] is null (an older office
     * that did not send `WorkerInfo.queue`), falls back to local [pending] receipts; when present,
     * enriches [queuedItems] with local receipts and appends receipts still within [GRACE_MS].
     */
    fun shown(queuedItems: List<QueuedMessageItem>?, now: Long = System.currentTimeMillis()): List<Shown> =
        mergeQueued(queuedItems, used = HashSet(), now = now)

    private fun mergeQueued(queuedItems: List<QueuedMessageItem>?, used: MutableSet<Int>, now: Long): List<Shown> {
        fun own(p: Prompt, item: QueuedMessageItem? = null) = Shown(
            key = item?.id?.let { "id:$it" } ?: "sent:${p.id}",
            text = p.text,
            hasImage = p.hasImage || (item?.hasImage == true),
            preview = false,
            more = 0,
            id = item?.id,
            serverIndex = item?.index?.takeIf { it > 0 },
        )
        if (queuedItems == null) return pending.filter { it.id !in used }.map { own(it) }
        val out = queuedItems.mapIndexed { i, item ->
            val p = pending.firstOrNull { it.id !in used && matchesPrompt(item, it) }
            if (p == null) {
                Shown(
                    key = item.id?.let { "id:$it" } ?: "droid:$i:${item.text}",
                    text = item.text,
                    hasImage = item.hasImage,
                    preview = item.preview || item.moreLines > 0,
                    more = item.moreLines,
                    id = item.id,
                    serverIndex = item.index.takeIf { it > 0 },
                )
            } else {
                used += p.id
                p.seen = now
                own(p, item)
            }
        }.toMutableList()
        pending = pending.filter { it.id in used || now - maxOf(it.at, it.seen) < GRACE_MS }
        for (p in pending) if (p.id !in used) out += own(p)
        if (pending.isEmpty()) consumed.clear()
        return out
    }

    /**
     * Factory's queued messages panel: mid-turn steering messages (`next_step` / `steering`) above
     * end-of-turn queued messages (`after_turn`), carrying daemon `requestId` (`id`) for exact actions.
     */
    data class Panel(
        val steering: List<Item>,
        val queued: List<Item>,
        val moreSteering: Int = 0,
        val moreQueued: Int = 0,
    ) {
        /** [index] is 0-based within [group]; [id] is the daemon requestId when present. */
        data class Item(
            val key: String,
            val group: Group,
            val index: Int,
            val text: String,
            val hasImage: Boolean,
            val preview: Boolean,
            val more: Int,
            val id: String? = null,
            val serverIndex: Int? = null,
        )
        val items get() = steering + queued
        val total get() = steering.size + queued.size + moreSteering + moreQueued
        val isEmpty get() = total == 0

        companion object {
            val EMPTY = Panel(emptyList(), emptyList())
        }
    }

    /** Splits structured [server] queue items into steering and queued groups; when [server] is null, shows local [pending] receipts. */
    fun panel(server: WorkerQueueState?, now: Long = System.currentTimeMillis()): Panel {
        val used = HashSet<Int>()
        val steeringItems = server?.items?.filter { it.isSteering }.orEmpty()
        val steering = steeringItems.mapIndexed { i, item ->
            val p = pending.firstOrNull { it.id !in used && matchesPrompt(item, it) }
            if (p != null) {
                used += p.id
                p.seen = now
            }
            Panel.Item(
                key = item.id?.let { "steer:$it" } ?: "steer:$i:${item.text}",
                group = Group.Steering,
                index = i,
                text = p?.text ?: item.text,
                hasImage = (p?.hasImage == true) || item.hasImage,
                preview = if (p != null) false else item.preview || item.moreLines > 0,
                more = if (p != null) 0 else item.moreLines,
                id = item.id,
                serverIndex = item.index.takeIf { it > 0 },
            )
        }
        val queuedServer = server?.items?.filterNot { it.isSteering }
        val queued = mergeQueued(queuedServer, used, now).mapIndexed { i, s ->
            Panel.Item(
                key = s.key,
                group = Group.Queued,
                index = i,
                text = s.text,
                hasImage = s.hasImage,
                preview = s.preview,
                more = s.more,
                id = s.id,
                serverIndex = s.serverIndex,
            )
        }
        return Panel(steering, queued, server?.moreSteering ?: 0, server?.moreQueued ?: 0)
    }

    companion object {
        /** Grace window for an optimistic local send before the next `worker.update` or `thread.snapshot` reflects it. */
        const val GRACE_MS = 4_000L

        internal fun matchesPrompt(item: QueuedMessageItem, prompt: Prompt): Boolean {
            if (prompt.text.isEmpty() && item.text.isEmpty()) return prompt.hasImage && item.hasImage
            if (!item.preview && item.moreLines <= 0) return prompt.text.trim() == item.text.trim()
            val firstLine = prompt.text.lineSequence().firstOrNull()?.trim().orEmpty()
            val prefix = item.text.trim().trimEnd('…', '.').trimEnd()
            return prefix.isNotEmpty() && firstLine.startsWith(prefix)
        }
    }
}
