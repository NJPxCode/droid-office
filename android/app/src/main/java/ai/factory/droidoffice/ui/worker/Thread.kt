package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.withFrameNanos
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DroidQueue
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.NoticeTone
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.PendingAsk
import ai.factory.droidoffice.core.ScreenState
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadImage
import ai.factory.droidoffice.core.ThreadPhase
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.ThreadRole
import ai.factory.droidoffice.core.ThreadRow
import ai.factory.droidoffice.core.ThreadState
import ai.factory.droidoffice.core.ThreadSupport
import ai.factory.droidoffice.core.ThreadView
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.asks.AskCard
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/** Thread or Raw TTY, at the start of the worker's one band of chrome in both views: compact, near-square, mono. */
@Composable
internal fun InlineViewToggle(tty: Boolean, onTty: (Boolean) -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Row(Modifier.background(Palette.Surface, shape).border(1.dp, Palette.Border, shape).padding(2.dp)) {
        InlineSegment("Thread", !tty, Tags.Worker.VIEW_THREAD) { onTty(false) }
        InlineSegment("Raw TTY", tty, Tags.Worker.VIEW_TTY) { onTty(true) }
    }
}

@Composable
private fun InlineSegment(text: String, on: Boolean, tag: String, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(3.dp)).background(if (on) Palette.SurfaceHigh else Color.Transparent)
            .clickable(role = Role.Tab, onClick = onClick).semantics { selected = on }.tagged(tag)
            .heightIn(min = 30.dp).padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (on) Palette.Text else Palette.TextSecondary))
    }
}

private const val LOADING_POLL_MS = 2_000L
private const val RECONCILE_POLL_MS = 15_000L
private const val HEAD = "thread.head"
private const val NEWER = "thread.newer"
private const val ASK = "thread.ask"
/** The receipts' item in the list, and its open state in the open map. */
private const val QUEUED = "thread.queued"
/** Sticky TodoWrite plan bar open state in the saved open map. */
private const val PLAN_BAR = "thread.plan.bar"
internal const val DIFF_FULL = "diff.full:"
/** A tool's arguments or result longer than this shows its start, so one huge log can't stall the list. */
internal const val SHOWN_CHARS = 6_000
/** Where a long message from the owner is kept shown in full, in the map of what is open. */
private const val MORE = "more:"
/** A message from the owner taller than this many lines shows its start, so a long brief can't fill the screen. */
private const val USER_LINES = 8

/**
 * The worker's conversation as the office presents it ([ThreadRow]): what it was asked and what it
 * said, with exploration folded into compact 1-level disclosures and File Change, Command and
 * Delegation cards rendered directly in turn order. Subscribes via `thread.watch` for live server
 * pushes while visible and connected, falling back to low-frequency reconciliation.
 */
@Composable
internal fun Thread(
    w: WorkerInfo,
    screen: ScreenState?,
    canAnswer: Boolean,
    connected: Boolean,
    modifier: Modifier,
    queued: ThreadQueue,
    queueRevision: Int,
    /** False while this worker's queued messages are still being read from the phone: they aren't matched against the thread until then. */
    queueReady: Boolean,
    onQueueChanged: () -> Unit,
    onTty: () -> Unit,
    /** Goes up when the owner sends a message from the composer: the thread follows the latest again. */
    followRequest: Int = 0,
    /** It has a terminal to fall back on; a cloud worker doesn't. */
    rawTty: Boolean = true,
    onOpenWorker: ((String) -> Unit)? = null,
    /** This screen's feeds by office, floor and worker, so the Thread comes back from Raw TTY with what it loaded. */
    feeds: MutableMap<String, ThreadFeed> = remember { mutableMapOf() },
) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val data by connection.data.collectAsStateWithLifecycle()
    val effectiveFloor = data.workerFloorId(w.id) ?: data.floorId
    // A new feed per office, floor and worker (the Orchestrator's is the building's): its request ids are its own, so no other's answers land here.
    val floorScope = MissionControl.floorScope(effectiveFloor, w.id)
    val kept = "${data.officeId}/$floorScope/${w.id}"
    val feed = remember(kept) { feeds.getOrPut(kept) { ThreadFeed(w.id) } }
    // Out of view (Raw TTY), its answers go unheard: what it asked is forgotten, what it loaded stays.
    DisposableEffect(feed) { onDispose { feed.disconnected() } }
    var state by remember(feed) { mutableStateOf(feed.state) }
    var polls by remember(feed) { mutableIntStateOf(0) }
    val life by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val visible = life.isAtLeast(Lifecycle.State.STARTED)

    LaunchedEffect(feed) {
        connection.threads.collect { if (feed.receive(it)) state = feed.state }
    }
    DisposableEffect(feed, connected, visible) {
        if (connected && visible) {
            connection.send(ClientMsg.threadWatch(w.id, true))
        }
        onDispose {
            if (connected && visible) {
                connection.send(ClientMsg.threadWatch(w.id, false))
            }
        }
    }
    LaunchedEffect(feed, connected, visible, polls) {
        if (!connected) {
            feed.disconnected()
            state = feed.state
            return@LaunchedEffect
        }
        if (!visible) return@LaunchedEffect
        while (isActive) {
            val now = System.currentTimeMillis()
            feed.latest(now)?.let { req -> if (!connection.send(ClientMsg.threadRead(w.id, req))) feed.unsent(req) }
            feed.tick(now)
            state = feed.state
            delay(if (feed.state.phase == ThreadPhase.Loading) LOADING_POLL_MS else RECONCILE_POLL_MS)
        }
    }
    LaunchedEffect(state.loadingEarlier) {
        while (state.loadingEarlier) {
            delay(1_000L)
            if (feed.tick(System.currentTimeMillis())) state = feed.state
        }
    }

    val menu = remember(w.isShell, screen) { Asks.menu(w, screen) }
    val asking = w.state == WorkerStatus.NeedsInput
    val showAsk = asking || menu?.pointer != null
    // Nothing from a presentation this app can't read is shown: the head says why instead.
    val rows = if (state.support == ThreadSupport.Supported) state.rows else emptyList()
    val loaded = remember(state.entries) { state.entries.associateBy { it.id } }
    // Droid's queue as its screen shows it, with the whole text of what this phone sent to it.
    val droidQueue = remember(screen) { screen?.let(DroidQueue::read) }
    var clock by remember(feed) { mutableLongStateOf(0L) }
    var pendingQueue by remember(queued) { mutableStateOf(emptyList<ThreadQueue.Shown>()) }
    var holding by remember(queued) { mutableStateOf(false) }
    LaunchedEffect(queued, queueRevision, queueReady, state.sessionId, state.entries, droidQueue, clock) {
        val before = queued.snapshot()
        if (queueReady) queued.sync(state.sessionId, state.entries)
        pendingQueue = queued.shown(droidQueue, System.currentTimeMillis())
        holding = queued.pending.isNotEmpty()
        if (queueReady && before != queued.snapshot()) onQueueChanged()
    }
    // A message sent to the queue that Droid never draws goes after a few seconds: look again until then.
    LaunchedEffect(holding) {
        while (holding) {
            delay(1_000)
            clock = System.currentTimeMillis()
        }
    }
    val list = rememberLazyListState()
    // What the owner opened, whether they're following and where they were reading survive a font,
    // density or theme change recreating the screen, or Raw TTY and back, for this office, floor and worker only.
    // What this device opened or closed, by the model's ids (ThreadView.Open); the rest opens as the model says.
    val open = rememberSaveable(kept, saver = OpenSaver) { mutableStateMapOf() }
    var openSession by rememberSaveable(kept) { mutableStateOf<String?>(null) }
    LaunchedEffect(state.sessionId) {
        val session = state.sessionId ?: return@LaunchedEffect
        if (openSession != null && openSession != session) open.clear()
        openSession = session
    }
    var follow by rememberSaveable(kept) { mutableStateOf(true) }
    // Set by opening anything to read it: reaching the bottom then doesn't follow again until the
    // owner jumps to the latest or sends a message, so what they opened isn't scrolled away by the next entry.
    var inspecting by rememberSaveable(kept) { mutableStateOf(false) }
    val place = rememberSaveable(kept, saver = PlaceSaver) { Place() }
    var anchor by remember(feed) { mutableStateOf<Pair<String, Int>?>(null) }
    var seen by remember(feed) { mutableStateOf<String?>(null) }
    // Set while the thread scrolls itself to the bottom, so its own scroll never reads as the owner's.
    var autoScrolling by remember(feed) { mutableStateOf(false) }
    // Following, yet the bottom stayed below the fold: the strip shows rather than hide where the latest is.
    var stuck by remember(feed) { mutableStateOf(false) }

    LaunchedEffect(list) {
        snapshotFlow { Triple(list.isScrollInProgress, list.canScrollForward, list.lastScrolledBackward) }.collect { (scrolling, more, back) ->
            if (scrolling && !autoScrolling) {
                if (back) follow = false else if (!more && !inspecting) follow = true
            }
        }
    }
    // Where the owner is reading, by row key rather than index: after a recreation the rows load
    // again from nothing, and an index would point at whatever happens to be there first.
    LaunchedEffect(list, rows) {
        snapshotFlow { list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset }.collect { (index, offset) ->
            if (place.pending || rows.isEmpty()) return@collect
            place.key = if (index == 0) null else rows.getOrNull(index - 1)?.id
            place.offset = offset
            place.session = state.sessionId
        }
    }
    LaunchedEffect(rows) {
        if (!place.pending || rows.isEmpty()) return@LaunchedEffect
        val key = place.key
        val at = rows.indexOfFirst { it.id == key }
        place.pending = false
        if (follow || key == null || at < 0 || (place.session != null && place.session != state.sessionId)) return@LaunchedEffect
        autoScrolling = true
        try {
            list.scrollToItem(at + 1, place.offset)
        } finally {
            autoScrolling = false
        }
    }
    LaunchedEffect(follow, rows.lastOrNull()?.id) {
        if (follow) seen = rows.lastOrNull()?.id
    }
    /** False when the owner's touch took the list over part way: their scroll wins. */
    suspend fun toBottom(): Boolean {
        autoScrolling = true
        return try {
            val lastItem = list.layoutInfo.totalItemsCount - 1
            if (lastItem >= 0 && list.layoutInfo.visibleItemsInfo.none { it.index == lastItem }) list.scrollToItem(lastItem)
            list.scrollBy(100_000f)
            true
        } catch (e: CancellationException) {
            currentCoroutineContext().ensureActive()
            false
        } finally {
            autoScrolling = false
        }
    }
    // Following means staying at the bottom through anything that pushes it down: a new entry or
    // result, a queued turn, the question card, or a font, density or window change re-laying it out.
    LaunchedEffect(list, feed) {
        // The viewport's size is in the key: the keyboard opening shrinks it over several frames, and
        // once it settles, a list that couldn't reach the bottom while it moved tries again.
        snapshotFlow { Triple(follow && anchor == null && !state.newerTrimmed && list.canScrollForward, list.isScrollInProgress && !autoScrolling, list.layoutInfo.viewportSize) }
            .collect { (behind, ownerScrolling, _) ->
                if (!behind) stuck = false
                if (!behind || ownerScrolling || autoScrolling) return@collect
                // A layout can lag the first scroll by a frame: try again, then say so with the strip.
                repeat(3) {
                    if (!toBottom()) return@collect
                    withFrameNanos { }
                    if (!list.canScrollForward) {
                        stuck = false
                        return@collect
                    }
                }
                stuck = true
            }
    }
    LaunchedEffect(state.entries.firstOrNull()?.id, state.loadingEarlier) {
        val (id, offset) = anchor ?: return@LaunchedEffect
        if (state.loadingEarlier) return@LaunchedEffect
        val at = ThreadView.rowOf(rows, id)
        if (at >= 0) {
            list.scrollToItem(at + 1)
            list.scrollBy(-offset.toFloat())
        }
        anchor = null
    }

    fun earlier() {
        if (!connected) return
        val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key != HEAD }
        val (req, before) = feed.earlier(System.currentTimeMillis()) ?: return
        // Hold on to the row's newest entry: an earlier page can only add to a row from its start.
        val row = rows.firstOrNull { it.id == first?.key } ?: rows.firstOrNull()
        anchor = row?.let { r -> (r.sourceIds.lastOrNull() ?: r.id) to (first?.takeIf { it.key == r.id }?.offset ?: 0) }
        follow = false
        if (!connection.send(ClientMsg.threadRead(w.id, req, before))) feed.unsent(req)
        state = feed.state
    }

    /** Opening something to read it: the next entry mustn't scroll it away, even at the bottom. */
    fun inspect() {
        follow = false
        inspecting = true
    }

    /** The owner's own way back to following: Jump to latest, Back to the latest, or sending a message. */
    fun resume() {
        inspecting = false
        follow = true
        scope.launch { toBottom() }
    }

    fun newer() {
        if (!connected) return
        feed.backToLatest()
        state = feed.state
        inspecting = false
        follow = true
        polls++
    }

    var resumed by remember(feed) { mutableIntStateOf(followRequest) }
    LaunchedEffect(followRequest) {
        if (followRequest == resumed) return@LaunchedEffect
        resumed = followRequest
        resume()
    }

    fun retry() {
        if (!connected) return
        feed.retry()
        state = feed.state
        polls++
    }

    fun toggleExploration(seg: ThreadView.Segment.Exploration, defaultOpen: Boolean) {
        val choices = ThreadView.Open.toggleExploration(seg, defaultOpen, open)
        open.putAll(choices)
        if (choices[seg.key] == true) inspect()
    }

    /** Opens or closes a call's details, a card, a thought or a long message, by its key in [open]. */
    fun flip(key: String, isOpen: Boolean) {
        open[key] = !isOpen
        if (!isOpen) inspect()
    }

    val allWorkers = remember(data) { data.allDeskWorkers }
    val activePlan = remember(state.entries, w.state.busy, w.todos) {
        val fromEntries = ThreadView.latestPlan(state.entries, w.state.busy)
        if (fromEntries != null) fromEntries.takeUnless { it.stale } else ThreadView.fallbackPlan(w.todos)
    }
    val pictures = remember(effectiveFloor, w.id) { effectiveFloor?.let { PictureSource(it, w.id) } }
    val floorDir = remember(data.floors, effectiveFloor) { data.floors.firstOrNull { it.id == effectiveFloor }?.dir }
    Column(modifier.background(ThreadPalette.Bg).tagged(Tags.Worker.THREAD)) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().clipToBounds()) {
            // On a wide screen the conversation keeps a reading width, centred, rather than lines across the whole window.
            val side = maxOf(18.dp, (maxWidth - READING_WIDTH) / 2)
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxSize().tagged(Tags.Worker.THREAD_LIST),
                contentPadding = PaddingValues(start = side, end = side, top = 4.dp, bottom = 16.dp),
            ) {
                item(key = HEAD) { Head(w, state, connected, rawTty, onEarlier = ::earlier, onRetry = ::retry, onTty = onTty) }
                itemsIndexed(rows, key = { _, r -> r.id }, contentType = { _, r -> r::class }) { i, r ->
                    Box(Modifier.padding(top = gap(if (i > 0) rows[i - 1] else null, r))) {
                        ProvidePictures(pictures) {
                            when (r) {
                                is ThreadRow.Message -> {
                                    val all = open[MORE + r.id] == true
                                    val isStreaming = w.state.busy && i == rows.lastIndex && r.role == ThreadRole.Assistant
                                    Message(w, r, loaded[r.id]?.text.orEmpty(), loaded[r.id]?.images.orEmpty(), all, isStreaming, floorDir) { flip(MORE + r.id, all) }
                                }
                                is ThreadRow.Notice -> Notice(w, r, loaded[r.id])
                                is ThreadRow.Activity -> Activity(
                                    a = r,
                                    open = open,
                                    loaded = loaded,
                                    asking = asking,
                                    allWorkers = allWorkers,
                                    deskWorker = data::deskWorker,
                                    onOpenWorker = onOpenWorker,
                                    floorDir = floorDir,
                                    onToggleExploration = ::toggleExploration,
                                    onFlip = ::flip,
                                )
                            }
                        }
                    }
                }
                if (state.newerTrimmed) item(key = NEWER) {
                    Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Newer messages were let go to make room for older ones.",
                            style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,
                        )
                        QuietButton("Back to the latest", OfficeIcons.ArrowDown, Tags.Worker.THREAD_NEWER, connected, ::newer, Modifier.padding(top = 8.dp))
                    }
                }
                if (showAsk) item(key = ASK) {
                    Box(Modifier.padding(top = 12.dp)) {
                        if (menu == null) {
                            NeedsTty(w.name, Asks.question(PendingAsk(w, null), state.entries), onTty)
                        } else {
                            AskCard(
                                worker = w,
                                menu = menu,
                                question = remember(w, menu, state.entries) { Asks.question(PendingAsk(w, menu), state.entries) },
                                where = null,
                                context = null,
                                enabled = canAnswer,
                                inline = true,
                                connected = connected,
                                entries = state.entries,
                                onOpenThread = onTty,
                            )
                        }
                    }
                }
                // The messages Droid sends next, after the conversation, as the owner's own words waiting their turn.
                if (pendingQueue.isNotEmpty()) item(key = QUEUED) {
                    QueuedMessages(
                        pendingQueue,
                        canClear = connected && !droidQueue.isNullOrEmpty(),
                        onClear = {
                            if (screen?.let(DroidQueue::read).isNullOrEmpty()) return@QueuedMessages
                            if (!connection.send(ClientMsg.termInput(w.id, DroidQueue.CLEAR))) {
                                scope.launch { snackbar.showSnackbar("Couldn't reach the office. The queue is unchanged.") }
                            }
                        },
                    )
                }
            }
            Box(Modifier.align(Alignment.TopCenter).fillMaxWidth().height(8.dp).background(Brush.verticalGradient(listOf(ThreadPalette.Bg, Color.Transparent))))
            // Floats over the conversation's bottom corner rather than taking a row of its own above the composer.
            if (ThreadView.showJump(follow, stuck, list.canScrollForward) && rows.isNotEmpty() && !state.newerTrimmed) {
                val from = rows.indexOfFirst { it.id == seen }
                val fresh = if (from < 0) 0 else rows.drop(from + 1).count { it is ThreadRow.Message && it.role != ThreadRole.User }
                Jump(fresh, Modifier.align(Alignment.BottomEnd).padding(end = side, bottom = 8.dp), ::resume)
            }
        }
        if (activePlan != null && state.support == ThreadSupport.Supported) {
            val planOpen = open[PLAN_BAR] == true
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                StickyPlanBar(
                    plan = activePlan,
                    isOpen = planOpen,
                    onToggle = { open[PLAN_BAR] = !planOpen },
                    modifier = Modifier.widthIn(max = READING_WIDTH + 20.dp).fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 4.dp, bottom = 6.dp),
                )
            }
        }
    }
}

/**
 * The messages waiting in Droid's queue, oldest first: the owner's words across the column like their
 * other messages, hollow, under a line that says how many and offers to clear them. A row Droid
 * cut short shows what Droid shows, saying how many lines it left off.
 */
@Composable
private fun QueuedMessages(items: List<ThreadQueue.Shown>, canClear: Boolean, onClear: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 24.dp).tagged(Tags.Worker.THREAD_QUEUED)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
            Text(
                "QUEUED · ${items.size}", style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary),
                modifier = Modifier.padding(horizontal = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
            )
            Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
        }
        items.forEachIndexed { i, q ->
            Column(Modifier.fillMaxWidth().padding(top = 10.dp).queuedBlock().tagged(Tags.Worker.threadQueued(i + 1))) {
                Text(
                    q.text.ifEmpty { "Image attached" },
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp, color = ThreadPalette.TextSecondary),
                    maxLines = USER_LINES, overflow = TextOverflow.Ellipsis,
                )
                val more = when {
                    q.more > 0 -> "${q.more} more line${if (q.more == 1) "" else "s"}"
                    q.preview -> "Shortened"
                    q.hasImage && q.text.isNotEmpty() -> "Image attached"
                    else -> null
                }
                more?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ThreadPalette.TextTertiary), modifier = Modifier.padding(top = 2.dp)) }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (items.size == 1) "Sent once this turn is over." else "Sent in order once this turn is over.",
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ThreadPalette.TextTertiary), modifier = Modifier.weight(1f),
            )
            if (canClear) QuietButton("Clear queue", Icons.Default.Close, Tags.Worker.THREAD_QUEUED_CLEAR, true, onClear)
        }
    }
}

/** A message waiting its turn: the owner's block, hollow, so it reads as not sent yet. */
private fun Modifier.queuedBlock() = this.border(1.dp, ThreadPalette.BorderStrong, RoundedCornerShape(4.dp)).padding(horizontal = 12.dp, vertical = 9.dp)

/** Brings what was just opened into view once it's laid out, as far as it fits, without following the bottom. */
internal class Reveal(val modifier: Modifier, val ask: () -> Unit)

@Composable
internal fun rememberReveal(): Reveal {
    val requester = remember { BringIntoViewRequester() }
    var asked by remember { mutableIntStateOf(0) }
    LaunchedEffect(asked) {
        if (asked == 0) return@LaunchedEffect
        // Twice: once for the open content to compose, once for it to be measured.
        withFrameNanos { }
        withFrameNanos { }
        requester.bringIntoView()
    }
    return remember(requester) { Reveal(Modifier.bringIntoViewRequester(requester)) { asked++ } }
}

/** What the owner opened or closed, saved as each key behind a 1 or a 0. */
private val OpenSaver = Saver<SnapshotStateMap<String, Boolean>, ArrayList<String>>(
    save = { m -> ArrayList(m.map { (key, on) -> (if (on) "1" else "0") + key }) },
    restore = { saved -> mutableStateMapOf<String, Boolean>().apply { saved.filter { it.isNotEmpty() }.forEach { put(it.drop(1), it[0] == '1') } } },
)

/**
 * Where the owner was reading: the row at the top of the list and how far into it, in the session it
 * belonged to. Written as they scroll without recomposing anything; read only when the state is saved.
 */
private class Place {
    var key: String? = null
    var offset = 0
    var session: String? = null
    /** Restored and not yet scrolled back to. */
    var pending = false
}

private val PlaceSaver = Saver<Place, ArrayList<String?>>(
    save = { arrayListOf(it.key, it.offset.toString(), it.session) },
    restore = { saved ->
        Place().apply {
            key = saved.getOrNull(0)
            offset = saved.getOrNull(1)?.toIntOrNull() ?: 0
            session = saved.getOrNull(2)
            pending = key != null
        }
    },
)

/** Air between rows: most between turns, least between a message and the work that follows it. */
private fun gap(prev: ThreadRow?, row: ThreadRow): Dp {
    if (prev == null) return 8.dp
    return when (row) {
        is ThreadRow.Message -> when {
            row.role == ThreadRole.User -> if (prev is ThreadRow.Message && prev.role == ThreadRole.User) 8.dp else 28.dp
            row.startsTurn -> 20.dp
            prev is ThreadRow.Activity -> 10.dp
            else -> 14.dp
        }
        is ThreadRow.Activity -> if (prev is ThreadRow.Message) 10.dp else 6.dp
        is ThreadRow.Notice -> 16.dp
    }
}

/**
 * A down arrow back to the newest message and following it, with a count of the replies that came in
 * while the owner was reading further up. Only shown while there is content below the viewport, even
 * when following is paused.
 */
@Composable
private fun Jump(fresh: Int, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val label = if (fresh > 0) "$fresh new message${if (fresh == 1) "" else "s"}" else "Jump to latest"
    Box(modifier) {
        Box(
            Modifier.size(40.dp).clip(shape).background(ThreadPalette.SurfaceHigh).border(1.dp, ThreadPalette.BorderStrong, shape)
                .clickable(onClickLabel = "Jump to the latest message", role = Role.Button, onClick = onClick)
                .tagged(Tags.Worker.THREAD_JUMP),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                OfficeIcons.ArrowDown, null,
                Modifier.size(18.dp).semantics { contentDescription = label; liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.THREAD_JUMP_LABEL),
                tint = ThreadPalette.Text,
            )
        }
        if (fresh > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp).heightIn(min = 16.dp).widthIn(min = 16.dp)
                    .background(ThreadPalette.Accent, RoundedCornerShape(2.dp)).padding(horizontal = 4.dp).clearAndSetSemantics { },
                contentAlignment = Alignment.Center,
            ) {
                Text(if (fresh > 99) "99+" else "$fresh", style = LocalOfficeType.current.eyebrow.copy(color = Color.White))
            }
        }
    }
}

/** A low, hairline, mono button for the thread's own chrome: Load earlier, Back to the latest. */
@Composable
private fun QuietButton(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tag: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, tall: Boolean = false) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier.clip(shape).border(1.dp, ThreadPalette.BorderStrong, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick).tagged(tag)
            .heightIn(min = if (tall) 44.dp else 36.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(13.dp), tint = if (enabled) ThreadPalette.TextSecondary else ThreadPalette.TextTertiary)
        Spacer(Modifier.width(8.dp))
        Text(text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = if (enabled) ThreadPalette.Text else ThreadPalette.TextTertiary))
    }
}

/** The top of the list: load earlier, the start of the session, or why there's nothing to show. */
@Composable
private fun Head(w: WorkerInfo, state: ThreadState, connected: Boolean, rawTty: Boolean, onEarlier: () -> Unit, onRetry: () -> Unit, onTty: () -> Unit) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (state.entries.isEmpty() || state.support != ThreadSupport.Supported) {
            Empty(w, state, connected, rawTty, onRetry, onTty)
            return@Column
        }
        when {
            state.loadingEarlier -> Row(Modifier.heightIn(min = 36.dp).padding(top = 4.dp).tagged(Tags.Worker.THREAD_EARLIER), verticalAlignment = Alignment.CenterVertically) {
                Spinner(Modifier.size(12.dp), ThreadPalette.TextSecondary)
                Spacer(Modifier.width(8.dp))
                Text("Loading earlier messages…", style = MaterialTheme.typography.bodySmall)
            }
            state.hasMore -> Column(Modifier.padding(top = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                QuietButton("Load earlier", OfficeIcons.ArrowUp, Tags.Worker.THREAD_EARLIER, connected, onEarlier)
                state.earlierError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ThreadPalette.Danger, modifier = Modifier.padding(top = 6.dp)) }
            }
            else -> Eyebrow("Start of the session", Modifier.padding(vertical = 10.dp).tagged(Tags.Worker.THREAD_START), color = ThreadPalette.TextSecondary)
        }
        state.error?.let {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp).panel(RoundedCornerShape(4.dp), ThreadPalette.Danger.copy(alpha = 0.07f), ThreadPalette.Danger.copy(alpha = 0.32f))
                    .tagged(Tags.Worker.THREAD_ERROR).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("The office couldn't update the thread: $it", style = MaterialTheme.typography.bodySmall, color = ThreadPalette.Danger, modifier = Modifier.weight(1f).padding(vertical = 6.dp))
                Box(
                    Modifier.clip(RoundedCornerShape(3.dp)).clickable(enabled = connected, role = Role.Button, onClick = onRetry).tagged(Tags.Worker.THREAD_RETRY)
                        .heightIn(min = 36.dp).padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("RETRY", style = LocalOfficeType.current.eyebrow.copy(color = if (connected) ThreadPalette.Text else ThreadPalette.TextTertiary))
                }
            }
        }
    }
}

/** Loading, empty, unavailable, unreadable, failed or disconnected: what it means, and what can be done about it. */
@Composable
private fun Empty(w: WorkerInfo, state: ThreadState, connected: Boolean, rawTty: Boolean, onRetry: () -> Unit, onTty: () -> Unit) {
    data class Look(val title: String, val body: String, val color: Color, val retry: Boolean, val tty: Boolean)
    val look = when {
        !connected -> Look("Not connected", "Not connected. The thread loads once the phone reaches the office.", ThreadPalette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported ->
            Look(state.support.title.orEmpty(), state.support.message.orEmpty(), ThreadPalette.Warning, retry = false, tty = true)
        state.phase == ThreadPhase.Loading -> Look("Loading the conversation", "Loading the thread…", ThreadPalette.TextSecondary, retry = false, tty = false)
        // Its first prompt starts the session, and only then is there a conversation to read.
        w.id == ORCHESTRATOR_ID && w.sessionId == null && state.entries.isEmpty() ->
            Look("Starting its conversation", "The Orchestrator's conversation shows here once its session starts.", ThreadPalette.TextSecondary, retry = false, tty = true)
        state.phase == ThreadPhase.Error -> Look("Couldn't read the thread", "The office couldn't read the thread: ${state.error?.trimEnd('.') ?: "no reason given"}.", ThreadPalette.Danger, retry = true, tty = true)
        state.phase == ThreadPhase.Unavailable && !rawTty -> Look("No thread to show", "This office can't read this worker's Factory session yet. Update Droid Office on your computer, or try again.", ThreadPalette.Warning, retry = true, tty = false)
        state.phase == ThreadPhase.Unavailable -> Look("No thread to show", "This office doesn't send threads, or can't read this worker's session. Raw TTY shows everything.", ThreadPalette.Warning, retry = true, tty = true)
        else -> Look("Start a conversation", "Your messages and the worker’s replies will appear here.", ThreadPalette.TextTertiary, retry = false, tty = false)
    }
    val loading = connected && state.phase == ThreadPhase.Loading
    val unreadable = connected && state.phase == ThreadPhase.Ready && state.support != ThreadSupport.Supported
    Column(
        Modifier.fillMaxWidth().then(if (unreadable) Modifier.tagged(Tags.Worker.THREAD_UPDATE) else Modifier).padding(top = 56.dp, bottom = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (loading) Spinner(Modifier.size(16.dp), ThreadPalette.TextSecondary) else Box(Modifier.size(7.dp).background(look.color, RoundedCornerShape(1.dp)))
        }
        Text(
            look.title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 12.dp).semantics { heading() },
        )
        Text(
            look.body, style = MaterialTheme.typography.bodySmall, color = ThreadPalette.TextSecondary, textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp).padding(top = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.THREAD_STATE),
        )
        val tty = look.tty && rawTty
        if (look.retry || tty) {
            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (look.retry) QuietButton("Try again", OfficeIcons.Retry, Tags.Worker.THREAD_RETRY, connected, onRetry)
                if (tty) QuietButton("Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_RAW_TTY, true, onTty)
            }
        }
    }
    // Without a transcript, what it was asked is still worth showing.
    w.prompt?.takeIf { it.isNotBlank() && state.phase != ThreadPhase.Loading }?.let { p ->
        Text(
            p, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp), maxLines = 12, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(top = 28.dp).userBlock().tagged(Tags.Worker.THREAD_PROMPT),
        )
    }
}

/**
 * Opens and closes like a disclosure: TalkBack says expanded or collapsed, not on or off, while a
 * dump still reports it as `checked` when open.
 */
internal fun Modifier.disclosure(open: Boolean, onToggle: () -> Unit) =
    this.toggleable(open, role = Role.Button) { onToggle() }.semantics { stateDescription = if (open) "Expanded" else "Collapsed" }

/**
 * Lays the text out in full and shows its first [lines] lines of message type (15 sp on 22 sp), saying
 * whether it cut any off. The text underneath stays whole, so copying it copies all of it.
 */
private fun Modifier.clampLines(lines: Int, onClipped: (Boolean) -> Unit) = this.clipToBounds().layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(maxHeight = Constraints.Infinity))
    val limit = (22.sp * lines).roundToPx()
    onClipped(p.height > limit)
    layout(p.width, p.height.coerceAtMost(limit).coerceIn(constraints.minHeight, constraints.maxHeight)) { p.place(0, 0) }
}

/** The owner's own words: a raised, near-square slab across the reading column, as the Factory app sets them. */
private fun Modifier.userBlock() = this.background(ThreadPalette.UserSlab, RoundedCornerShape(4.dp)).padding(horizontal = 12.dp, vertical = 9.dp)

@Composable
private fun Message(w: WorkerInfo, m: ThreadRow.Message, text: String, images: List<ThreadImage>, all: Boolean, streaming: Boolean, floorDir: String?, onMore: () -> Unit) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(m.id))
    if (m.role == ThreadRole.User) {
        val reveal = rememberReveal()
        // The pictures sent with the prompt, above its text, in place of where the office kept them.
        val pictures = images.isNotEmpty() && LocalPictureSource.current != null
        Column(tag.then(reveal.modifier), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.End) {
            if (pictures) ThreadPictures(images, "Picture you sent", null, end = true)
            if (!pictures || text.isNotBlank()) Column(Modifier.fillMaxWidth().userBlock()) {
                var clipped by remember(m.id) { mutableStateOf(false) }
                SelectionContainer {
                    MarkdownText(text, if (all) Modifier else Modifier.clampLines(USER_LINES) { if (clipped != it) clipped = it }, surface = ThreadPalette.UserSlab, breaks = true)
                }
                if (all || clipped) {
                    Row(
                        Modifier.clip(RoundedCornerShape(3.dp)).disclosure(all) {
                            if (!all) reveal.ask()
                            onMore()
                        }.tagged(Tags.Worker.threadMore(m.id))
                            .heightIn(min = 40.dp).padding(top = 4.dp, end = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (all) "SHOW LESS" else "SHOW ALL", style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.Text))
                        Spacer(Modifier.width(6.dp))
                        Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (all) -90f else 90f), tint = ThreadPalette.TextSecondary)
                    }
                }
            }
        }
    } else {
        Column(tag) {
            val files = LocalFilePreview.current
            SelectionContainer { MarkdownText(text, streaming = streaming, onOpenPath = files?.let { it::open }, rich = true) }
            m.turnChanges?.let { TurnChanges(m.id, it, floorDir, Modifier.padding(top = 10.dp)) }
        }
    }
}

@Composable
private fun Notice(w: WorkerInfo, n: ThreadRow.Notice, entry: ThreadEntry?) {
    val tag = Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(n.id))
    when (n.tone) {
        NoticeTone.Attachment -> Box(tag, contentAlignment = if (n.role == ThreadRole.User) Alignment.CenterEnd else Alignment.CenterStart) {
            val images = entry?.images.orEmpty()
            // The picture stands in for "Image attached" wherever it can be shown.
            if (images.isNotEmpty() && LocalPictureSource.current != null) {
                ThreadPictures(images, if (n.role == ThreadRole.User) "Picture you sent" else "Picture from ${w.name}", null, end = n.role == ThreadRole.User)
            } else {
                Text(n.text, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary))
            }
        }
        NoticeTone.Danger -> Row(
            tag.panel(RoundedCornerShape(4.dp), ThreadPalette.Danger.copy(alpha = 0.07f), ThreadPalette.Danger.copy(alpha = 0.3f)).padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(ThreadPalette.Danger, RoundedCornerShape(1.dp)))
            Spacer(Modifier.width(10.dp))
            Text(n.text, style = MaterialTheme.typography.bodySmall, color = ThreadPalette.Danger)
        }
        NoticeTone.Quiet -> Row(tag, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
            Text(
                n.text.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary), textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 10.dp).weight(4f, fill = false),
            )
            Box(Modifier.weight(1f).height(1.dp).background(ThreadPalette.Border))
        }
    }
}


/** A question the phone can't read off the terminal: it's answered in Raw TTY, never with a prompt typed into it. */
@Composable
private fun NeedsTty(name: String, question: String, onTty: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), ThreadPalette.Danger.copy(alpha = 0.07f), ThreadPalette.Danger.copy(alpha = 0.4f))
            .tagged(Tags.Asks.CARD).padding(12.dp),
    ) {
        Eyebrow("${name.ifBlank { "Droid" }} needs your answer", color = ThreadPalette.Danger)
        Text(question, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.QUESTION))
        Text(
            "The phone can't read this question off the terminal. Answer it in Raw TTY.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp).tagged(Tags.Asks.WAITING),
        )
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.End) {
            QuietButton("Answer in Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_RAW_TTY, true, onTty)
        }
    }
}

/**
 * In place of the composer while a worker in the thread waits on a question: a prompt sent now would
 * be typed into the question on its terminal. The question card above answers it, or Raw TTY does.
 */
@Composable
internal fun ThreadWaiting(w: WorkerInfo, onTty: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp).panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.BorderStrong)
            .tagged(Tags.Worker.THREAD_WAITING).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "${w.name.ifBlank { "It" }} is waiting on a question. Answer it above, or in Raw TTY, before sending a message.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f).padding(vertical = 6.dp),
        )
        Spacer(Modifier.width(8.dp))
        QuietButton("Raw TTY", OfficeIcons.Terminal, Tags.Worker.THREAD_WAITING_TTY, true, onTty)
    }
}
