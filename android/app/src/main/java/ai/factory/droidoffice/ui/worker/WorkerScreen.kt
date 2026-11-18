package ai.factory.droidoffice.ui.worker

import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.text
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.factory.droidoffice.core.Asks
import ai.factory.droidoffice.core.ClientMsg
import ai.factory.droidoffice.core.DeepLinks
import ai.factory.droidoffice.core.EffortDial
import ai.factory.droidoffice.core.Keys
import ai.factory.droidoffice.core.Menu
import ai.factory.droidoffice.core.MissionAgent
import ai.factory.droidoffice.core.MissionControl
import ai.factory.droidoffice.core.MissionTeamMember
import ai.factory.droidoffice.core.Models
import ai.factory.droidoffice.core.ORCHESTRATOR_ID
import ai.factory.droidoffice.core.PhoneSizing
import ai.factory.droidoffice.core.QuickKeys
import ai.factory.droidoffice.core.Receipts
import ai.factory.droidoffice.core.SlashCommands
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.TermSize
import ai.factory.droidoffice.core.TermView
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFeed
import ai.factory.droidoffice.core.ThreadLive
import ai.factory.droidoffice.core.ThreadLiveState
import ai.factory.droidoffice.core.ThreadQueue
import ai.factory.droidoffice.core.ThreadTurns
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.core.WorkerStatus
import ai.factory.droidoffice.core.Workers
import ai.factory.droidoffice.net.nameOf
import ai.factory.droidoffice.session.Phase
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.LocalSnackbarLift
import ai.factory.droidoffice.ui.asks.QuestionWorkspaceDialog
import ai.factory.droidoffice.ui.components.EffortDialMark
import ai.factory.droidoffice.ui.components.SecondaryButton
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.StatusPill
import ai.factory.droidoffice.ui.components.WorkerDot
import ai.factory.droidoffice.ui.components.WorkerModelLogo
import ai.factory.droidoffice.ui.components.paneInsets
import ai.factory.droidoffice.ui.components.parseColor
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.home.deskLabel
import ai.factory.droidoffice.ui.home.rememberNow
import ai.factory.droidoffice.ui.mission.AgentTile
import ai.factory.droidoffice.ui.mission.BotScreen
import ai.factory.droidoffice.ui.mission.OrchestratorBlocked
import ai.factory.droidoffice.ui.mission.OrchestratorIdle
import ai.factory.droidoffice.ui.mission.OrchestratorSheet
import ai.factory.droidoffice.ui.mission.OrchestratorTint
import ai.factory.droidoffice.ui.mission.TeamStrip
import ai.factory.droidoffice.ui.mission.rememberFollow
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.Palette
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val PhoneSizingSaver = Saver<PhoneSizing, List<Int>>(
    save = { listOf(it.original?.cols ?: 0, it.original?.rows ?: 0) + it.sentSizes.flatMap { size -> listOf(size.cols, size.rows) } },
    restore = { PhoneSizing(if (it[0] > 0) TermSize(it[0], it[1]) else null, it.drop(2).chunked(2).map { size -> TermSize(size[0], size[1]) }) },
)

/** The messages this phone sent to a worker's queue, for this process, and what's on disk for them. */
private class QueueReceipts(val queue: ThreadQueue, var onDisk: String?)

private val localThreadQueues = mutableMapOf<String, QueueReceipts>()

@Composable
fun WorkerScreen(
    workerId: String,
    onBack: () -> Unit,
    embedded: Boolean = false,
    draft: String? = null,
    onOpenWorker: ((String) -> Unit)? = null,
    floorHint: String? = null,
    openQuestion: Boolean = false,
    questionId: String? = null,
    launchId: Int = 0,
) {
    val graph = LocalGraph.current
    val connection = graph.connection
    val data by connection.data.collectAsStateWithLifecycle()
    val link by connection.link.collectAsStateWithLifecycle()
    // Building agents aren't on any floor: the Orchestrator and the bots come from Mission Control.
    val mission = workerId == ORCHESTRATOR_ID
    val bot = data.mission?.bots?.firstOrNull { it.worker.id == workerId } ?: data.deskWorker(workerId)?.takeIf { it.remote }?.let { MissionAgent(it) }
    if (bot != null) {
        BotScreen(bot, embedded, onBack, onOpenWorker)
        return
    }
    val store by graph.store.snapshot.collectAsStateWithLifecycle()
    val officeSynced = data.synced && (store.active?.id == null || data.officeId == store.active?.id)
    val orchestrator = data.mission?.orchestrator
    if (mission && (orchestrator?.settings?.on != true || orchestrator.agent == null)) {
        OrchestratorIdle(orchestrator, officeSynced, embedded, onBack, onOpenWorker)
        return
    }
    val worker = data.worker(workerId)
    val resolvedHintFloor = if (mission || floorHint == null || !officeSynced) null else DeepLinks.resolveFloorId(data.floors, floorHint)
    val targetFloor = if (mission) null else data.workerFloorId(workerId) ?: resolvedHintFloor
    val ownerFloor = if (mission) null else data.workerFloorId(workerId) ?: resolvedHintFloor?.takeIf { worker != null }
    val awaitingFloorSwitch = !mission && officeSynced && !data.hasBuildingRoster && resolvedHintFloor != null && data.floorId != resolvedHintFloor
    val effectiveFloor = ownerFloor ?: data.floorId
    var switchedFloor by remember(workerId) { mutableStateOf(false) }
    LaunchedEffect(workerId, targetFloor, data.floorId, link.phase) {
        if (link.phase != Phase.Connected || mission || targetFloor == null) return@LaunchedEffect
        if (data.floorId != targetFloor) {
            if (connection.goFloor(targetFloor)) switchedFloor = true
        } else if (switchedFloor) {
            switchedFloor = false
            connection.resnapshot(workerId)
        }
    }

    val floorScope = MissionControl.floorScope(effectiveFloor, workerId)
    val queueKey = "${data.officeId}/$floorScope/$workerId"
    val keepable = !data.officeId.isNullOrBlank() && !floorScope.isNullOrBlank()
    var receipts by remember(workerId) { mutableStateOf(localThreadQueues[queueKey]?.takeIf { keepable } ?: QueueReceipts(ThreadQueue(), null)) }
    var receiptsFor by remember(workerId) { mutableStateOf(queueKey.takeIf { keepable && localThreadQueues[it] != null }) }
    val queueState = receipts.queue
    val queueReady = keepable && receiptsFor == queueKey
    var queueRevision by remember(workerId) { mutableIntStateOf(0) }
    LaunchedEffect(queueKey, keepable) {
        if (!keepable || receiptsFor == queueKey) return@LaunchedEffect
        val next = localThreadQueues[queueKey] ?: when (val loaded = graph.store.loadReceipts(queueKey)) {
            is Receipts.Loaded.Found -> QueueReceipts(ThreadQueue(loaded.snapshot), loaded.snapshot)
            is Receipts.Loaded.Failed -> QueueReceipts(ThreadQueue(), null)
        }
        if (receiptsFor == null) Receipts.merge(next.queue, receipts.queue)
        localThreadQueues[queueKey] = next
        receipts = next
        receiptsFor = queueKey
        queueRevision++
    }
    LaunchedEffect(receipts, queueRevision, queueReady) {
        if (!queueReady) return@LaunchedEffect
        delay(250)
        val r = receipts
        val snapshot = r.queue.snapshot().takeIf { r.queue.pending.isNotEmpty() }
        if (snapshot == r.onDisk) return@LaunchedEffect
        r.onDisk = if (graph.store.saveReceipts(queueKey, snapshot) == Receipts.Saved.Kept) snapshot else null
    }

    // Only explicit `shell` workers own a live terminal and phone PTY sizing; all Droid workers
    // (`agent`, `cloud`, `orchestrator`) render Thread-only and attach with `stream = false`.
    val isShell = worker?.isShell == true
    var phoneChoice by rememberSaveable(workerId) { mutableStateOf<Boolean?>(null) }
    val phone = phoneChoice ?: true
    val sizing = rememberSaveable(workerId, saver = PhoneSizingSaver) { PhoneSizing() }
    val activity = LocalActivity.current
    val ptySize by rememberUpdatedState(worker?.takeIf { it.isShell }?.let { TermSize(it.cols, it.rows) })

    DisposableEffect(workerId, isShell) {
        connection.attach(workerId, stream = isShell)
        graph.visibility.viewing.value = workerId
        graph.alerts.cancel(workerId)
        onDispose {
            if (isShell && activity?.isChangingConfigurations != true) {
                ptySize?.let { now -> sizing.restore(now) }?.let { connection.send(ClientMsg.termResize(workerId, it.cols, it.rows)) }
                sizing.release()
            }
            connection.detach(workerId)
            if (graph.visibility.viewing.value == workerId) graph.visibility.viewing.value = null
        }
    }

    Column(
        Modifier.fillMaxSize().tagged(Tags.Screen.WORKER).background(Palette.Bg).windowInsetsPadding(paneInsets(embedded))
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom)),
    ) {
        if (worker == null) {
            Gone(officeSynced && !awaitingFloorSwitch, embedded, onBack)
            return@Column
        }
        var sendingHome by remember { mutableStateOf(false) }
        var orchestratorMenu by remember { mutableStateOf(false) }
        var factoryLimits by remember(workerId) { mutableStateOf(false) }
        val blocked = if (mission) MissionControl.orchestratorBlocked(orchestrator) else null
        Header(worker, embedded, link.phase == Phase.Connected, onBack, onSendHome = { if (mission) orchestratorMenu = true else sendingHome = true }, mission = mission, blocked = blocked != null)
        val live = !worker.state.asleep
        val composing = live || mission
        val followTeamMember = rememberFollow(onOpenWorker)
        val shell = worker.isShell
        val cloud = worker.isCloud
        val scope = rememberCoroutineScope()
        val snackbarHost = LocalSnackbar.current

        val threadStates = rememberSaveableStateHolder()
        val threadFeeds = remember(workerId) { mutableMapOf<String, ThreadFeed>() }
        var directInput by rememberSaveable(workerId) { mutableStateOf(false) }
        var composerFocus by remember(workerId) { mutableIntStateOf(0) }
        var sent by remember(workerId) { mutableIntStateOf(0) }
        var quote by remember(workerId) { mutableStateOf<String?>(null) }
        var threadSearch by rememberSaveable(workerId) { mutableStateOf(false) }
        var queuePanel by remember(workerId) { mutableStateOf(ThreadQueue.Panel.EMPTY) }
        var composerFill by remember(workerId) { mutableStateOf<String?>(null) }
        var rewinding by remember(workerId) { mutableStateOf(false) }
        var rewindError by remember(workerId) { mutableStateOf<String?>(null) }
        var rewoundSessionId by remember(workerId) { mutableStateOf<String?>(null) }
        var threadEntries by remember(workerId) { mutableStateOf<List<ThreadEntry>>(emptyList()) }
        var copying by remember(workerId) { mutableStateOf(false) }
        var copyTurns by remember(workerId) { mutableStateOf("1") }
        val liveState = remember(workerId) { ThreadLiveState() }
        var threadLive by remember(workerId) { mutableStateOf<ThreadLive?>(null) }

        LaunchedEffect(worker.sessionId, rewoundSessionId) {
            if (rewoundSessionId != null && worker.sessionId == rewoundSessionId) rewoundSessionId = null
        }
        LaunchedEffect(workerId) {
            liveState.clear()
            connection.threadLives.collect { msg ->
                val session = rewoundSessionId ?: connection.data.value.worker(workerId)?.sessionId
                if (msg.workerId == workerId && liveState.receive(msg.sessionId, msg.live, session)) threadLive = liveState.live
            }
        }
        val activeSessionId = rewoundSessionId ?: worker.sessionId
        val currentThreadLive = threadLive?.takeIf { liveState.session == activeSessionId }

        LaunchedEffect(workerId) {
            connection.workerRewounds.collect { msg ->
                if (msg.workerId != workerId) return@collect
                rewinding = false
                if (msg.ok) {
                    rewindError = null
                    msg.sessionId?.takeIf { it.isNotBlank() }?.let { rewoundSessionId = it }
                    msg.text?.takeIf { it.isNotBlank() }?.let { composerFill = it }
                    msg.note?.let { note -> scope.launch { snackbarHost.showSnackbar(note) } }
                    sent++
                } else {
                    rewindError = msg.error ?: "Failed to rewind conversation"
                }
            }
        }

        val questionScopeKey = "$workerId/${questionId.orEmpty()}/$launchId"
        var questionHandled by rememberSaveable(questionScopeKey) { mutableStateOf(false) }
        var openedQuestionMenu by remember(questionScopeKey) { mutableStateOf<Menu?>(null) }
        LaunchedEffect(worker.state) {
            if (openedQuestionMenu != null && worker.state != WorkerStatus.NeedsInput) openedQuestionMenu = null
        }
        LaunchedEffect(openQuestion, questionScopeKey, link.phase, officeSynced, worker.state, worker.menu, worker.cloud?.menu) {
            if (!openQuestion || questionHandled || link.phase != Phase.Connected || !officeSynced) return@LaunchedEffect
            if (worker.state != WorkerStatus.NeedsInput) {
                questionHandled = true
                if (questionId?.startsWith("team:") != true) {
                    snackbarHost.showSnackbar("${worker.name.ifBlank { worker.id }} isn’t waiting on a question anymore.")
                }
                return@LaunchedEffect
            }
            val menu = Asks.menu(worker)
            if (menu != null) {
                questionHandled = true
                openedQuestionMenu = menu
            }
        }

        if (!shell) {
            Column(Modifier.fillMaxWidth().background(Palette.Bg)) {
                Actions(worker, lead = {
                    Box(
                        Modifier.size(36.dp).clip(RoundedCornerShape(4.dp))
                            .clickable(role = Role.Button, onClickLabel = "Search session") { threadSearch = !threadSearch }
                            .semantics { selected = threadSearch }.tagged(Tags.Worker.THREAD_SEARCH),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(OfficeIcons.Search, "Search session", Modifier.size(16.dp), tint = if (threadSearch) Palette.Accent else Palette.TextSecondary)
                    }
                }, resumable = !mission)
                if (mission) TeamStrip(MissionControl.team(orchestrator), onOpen = { followTeamMember?.invoke(it) })
                Box(Modifier.fillMaxWidth().height(4.dp))
                Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.Border))
            }
        } else {
            Actions(worker)
        }

        Offline(link.phase, thread = !shell, composing = composing && !(!shell && worker.state == WorkerStatus.NeedsInput))

        if (shell) {
            val screens by connection.screens.collectAsStateWithLifecycle()
            val screen = screens[workerId]
            var phoneSize by remember(workerId) { mutableStateOf<TermSize?>(null) }
            var kittyFlags by remember(workerId) { mutableIntStateOf(0) }
            val currentSize = TermSize(worker.cols, worker.rows)
            val canResize = live && link.phase == Phase.Connected && screen != null
            LaunchedEffect(phone, phoneSize, canResize, currentSize) {
                if (!canResize) {
                    sizing.disconnected()
                    return@LaunchedEffect
                }
                if (phone) {
                    if (sizing.takenOver(currentSize)) {
                        sizing.release()
                        phoneChoice = false
                        return@LaunchedEffect
                    }
                    val target = phoneSize ?: return@LaunchedEffect
                    delay(150)
                    sizing.request(currentSize, target)?.let { size ->
                        if (connection.send(ClientMsg.termResize(workerId, size.cols, size.rows))) sizing.sent(size)
                    }
                } else {
                    val restore = sizing.restore(currentSize)
                    if (restore == null || connection.send(ClientMsg.termResize(workerId, restore.cols, restore.rows))) sizing.release()
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp)) {
                Terminal(
                    workerId, screen, if (phone) TermView.Phone else TermView.Desktop, live && link.phase == Phase.Connected,
                    Modifier.fillMaxSize().border(1.dp, Palette.Border, RoundedCornerShape(12.dp)),
                    onFit = { phoneSize = it },
                    directInput = directInput,
                    csiEnter = false,
                    onKittyFlags = { kittyFlags = it },
                )
                if (worker.state.asleep) Asleep(worker)
            }
            if (composing) {
                val lift = LocalSnackbarLift.current
                val density = LocalDensity.current
                DisposableEffect(lift) { onDispose { lift.value = null } }
                Column(Modifier.background(Palette.Bg).onSizeChanged { lift.value = with(density) { it.height.toDp() } + 8.dp }) {
                    QuickKeyRow(
                        workerId = workerId,
                        phone = phone,
                        directInput = directInput,
                        connected = link.phase == Phase.Connected,
                        kittyFlags = kittyFlags,
                        onPhone = { phoneChoice = !phone },
                        onDirect = {
                            directInput = !directInput
                            if (!directInput) composerFocus++
                        },
                    )
                    Composer(
                        worker,
                        draft = draft,
                        visible = !directInput,
                        focusRequest = composerFocus,
                        thread = false,
                        connected = link.phase == Phase.Connected,
                    )
                }
            }
        } else {
            val openSubagent: ((String) -> Unit)? = onOpenWorker?.let { open ->
                { targetId ->
                    val teamMember = MissionControl.team(orchestrator).firstOrNull { it.id == targetId }
                        ?: data.deskWorker(targetId)?.let { target ->
                            val targetFloor = data.workerFloorId(target.id)
                            if (targetFloor != null && targetFloor != data.floorId) {
                                MissionTeamMember(
                                    id = target.id,
                                    name = target.name,
                                    floor = targetFloor,
                                    floorName = data.floorOfWorker(target.id)?.name.orEmpty(),
                                    status = target.status,
                                )
                            } else null
                        }
                    if (teamMember != null && followTeamMember != null) followTeamMember(teamMember)
                    else open(targetId)
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val quotable = composing && blocked == null && worker.state != WorkerStatus.NeedsInput
                ProvideFilePreview(worker) {
                    QuoteSelections(quotable, onQuote = { quote = it }) {
                        threadStates.SaveableStateProvider("thread/$workerId") {
                            Thread(
                                w = worker,
                                canAnswer = live && link.phase == Phase.Connected,
                                connected = link.phase == Phase.Connected,
                                modifier = Modifier.fillMaxSize(),
                                queued = queueState,
                                queueRevision = queueRevision,
                                queueReady = queueReady,
                                onQueueChanged = { queueRevision++ },
                                followRequest = sent,
                                sessionIdOverride = rewoundSessionId,
                                onOpenWorker = openSubagent,
                                search = threadSearch,
                                onSearch = { threadSearch = it },
                                onQuote = { quote = it },
                                onQueuePanel = { queuePanel = it },
                                live = currentThreadLive,
                                onRewind = if (link.phase == Phase.Connected && !cloud && data.threadActions) { entryId, restore, files ->
                                    rewinding = true
                                    rewindError = null
                                    if (!connection.send(ClientMsg.rewind(workerId, entryId, restore, files))) {
                                        rewinding = false
                                        rewindError = "Couldn't reach the office. Nothing was rewound."
                                    }
                                } else null,
                                rewinding = rewinding,
                                rewindError = rewindError,
                                onRewindCancel = { rewindError = null },
                                feeds = threadFeeds,
                                onEntries = { threadEntries = it },
                            )
                        }
                    }
                }
            }
            val cloudError = worker.cloud?.error?.ifBlank { null }
            if (cloud && cloudError != null && !live) CloudError(worker, cloudError)
            if (composing) {
                val lift = LocalSnackbarLift.current
                val density = LocalDensity.current
                DisposableEffect(lift) { onDispose { lift.value = null } }
                Column(Modifier.background(ThreadPalette.Bg).onSizeChanged { lift.value = with(density) { it.height.toDp() } + 8.dp }) {
                    val waiting = worker.state == WorkerStatus.NeedsInput
                    if (waiting) ThreadWaiting(worker)
                    val snackbar = LocalSnackbar.current
                    val connected = link.phase == Phase.Connected
                    if (cloud && cloudError != null) CloudError(worker, cloudError)
                    if (blocked != null && !waiting) OrchestratorBlocked(blocked)
                    Composer(
                        worker,
                        draft = draft,
                        visible = blocked == null && !waiting,
                        focusRequest = composerFocus,
                        thread = true,
                        quote = quote,
                        onQuoted = { quote = null },
                        fill = composerFill,
                        onFilled = { composerFill = null },
                        prompts = remember(threadEntries) { ThreadTurns.prompts(threadEntries) },
                        queueState = queueState,
                        onQueued = { queueRevision++ },
                        queuePanel = queuePanel,
                        onQueueAction = if (connected && !cloud && data.threadActions) { action, item ->
                            val kind = if (action == "edit") "delete" else action
                            val index = item.serverIndex ?: (item.index + 1)
                            val ok = connection.send(ClientMsg.queueAction(
                                workerId = workerId,
                                action = kind,
                                index = index,
                                group = item.group.wire,
                                text = item.text.takeUnless { item.preview || it.isEmpty() },
                                id = item.id,
                            ))
                            if (ok) {
                                queueState.remove(item.text)
                                queueRevision++
                                if (action == "edit") composerFill = item.text
                            } else {
                                scope.launch { snackbar.showSnackbar("Couldn't reach the office. The queue is unchanged.") }
                            }
                        } else null,
                        onSent = { prompt ->
                            sent++
                            val slash = SlashCommands.of(prompt)
                            if (slash != null) {
                                scope.launch { snackbar.showSnackbar("Sent /${slash.first} to ${worker.name}.") }
                            }
                        },
                        connected = connected,
                        blocked = cloud && cloudError != null,
                        onStop = if (worker.state.busy) {
                            {
                                if (!connection.send(ClientMsg.interrupt(workerId))) {
                                    scope.launch { snackbar.showSnackbar("Couldn't reach the office. Nothing was sent.") }
                                }
                            }
                        } else null,
                        intercept = { prompt ->
                            val slash = SlashCommands.of(prompt)
                            when {
                                slash?.second?.name == "limits" -> {
                                    factoryLimits = true
                                    true
                                }
                                SlashCommands.nativeCopy(prompt) -> {
                                    copyTurns = SlashCommands.copyTurns(prompt)
                                    copying = true
                                    true
                                }
                                slash == null -> false
                                slash.second?.kind == SlashCommands.Kind.Blocked -> {
                                    scope.launch { snackbar.showSnackbar(if (mission) "/${slash.first} would end the Orchestrator’s Droid. Start a new conversation from its menu instead." else "/${slash.first} would end ${worker.name}’s Droid. Send it home instead.") }
                                    true
                                }
                                worker.state.busy && slash.second?.midTurn != true -> {
                                    scope.launch { snackbar.showSnackbar(SlashCommands.refusal(prompt, worker.name, busy = true).orEmpty()) }
                                    true
                                }
                                else -> false
                            }
                        },
                    )
                }
            }
        }

        if (sendingHome) SendHomeDialog(worker, onDismiss = { sendingHome = false }, onSent = {
            sendingHome = false
            onBack()
        })
        if (orchestratorMenu && orchestrator != null) OrchestratorSheet(orchestrator, onDismiss = { orchestratorMenu = false })
        if (factoryLimits) ai.factory.droidoffice.ui.offices.SubscriptionsSheet { factoryLimits = false }
        if (copying) ThreadCopyDialog(threadEntries, activeSessionId, initialTurns = copyTurns, onDismiss = { copying = false })
        openedQuestionMenu?.let { menu ->
            QuestionWorkspaceDialog(
                worker = worker,
                menu = menu,
                onDismiss = { openedQuestionMenu = null },
            )
        }
    }
}

@Composable
private fun Header(w: WorkerInfo, embedded: Boolean, connected: Boolean, onBack: () -> Unit, onSendHome: () -> Unit, mission: Boolean = false, blocked: Boolean = false) {
    val now = rememberNow()
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val catalogue by graph.connection.catalogue.collectAsStateWithLifecycle()
    val floorName = if (mission || data.floors.size <= 1) null else data.floorOfWorker(w.id)?.name?.ifBlank { null }
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Worker.BACK)) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        if (mission) Box(Modifier.padding(end = 8.dp)) { AgentTile(OfficeIcons.Orbit, if (w.state == WorkerStatus.NeedsInput) Palette.Danger else OrchestratorTint, small = true) }
        else WorkerDot(parseColor(w.color), w.state, 10.dp)
        Column(Modifier.weight(1f).padding(start = 2.dp)) {
            Text(w.name.ifBlank { w.id }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.tagged(Tags.Worker.NAME))
            var modelAt = -1
            val parts = buildList {
                if (mission) add("Mission Control")
                w.cloud?.where?.let { add("☁ $it") }
                if (w.isShell) add("Shell") else Workers.modelId(w)?.let {
                    modelAt = size
                    add(Models.plainName(catalogue.nameOf(it)))
                }
                if (!mission) {
                    floorName?.let(::add)
                    add(deskLabel(w.deskId).replaceFirstChar { it.uppercaseChar() })
                }
                Workers.workedMs(w, now).takeIf { it >= 1000 }?.let { add(Workers.duration(it)) }
            }
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                WorkerModelLogo(w, catalogue, modifier = Modifier.padding(top = 1.dp).size(14.dp), behind = Palette.Bg)
                val effort = Workers.effort(w)?.takeIf { modelAt >= 0 }
                val spoken = parts.toMutableList().apply { if (effort != null) add(modelAt + 1, EffortDial.label(effort)) }.joinToString(" · ")
                MetaLine(parts, Modifier.weight(1f).tagged(Tags.Worker.META), spoken, effort?.let { e -> { EffortDialMark(e, Modifier.padding(start = 6.dp)) } }, modelAt.coerceAtLeast(0))
            }
        }
        if (connected) StatusPill(w.state, acked = w.acked, tag = Tags.Worker.STATUS, blocked = blocked)
        if (mission) IconButton(onClick = onSendHome, modifier = Modifier.tagged(Tags.Orchestrator.MENU)) {
            Icon(Icons.Default.MoreVert, "Orchestrator settings", tint = Palette.TextSecondary)
        } else IconButton(onClick = onSendHome, modifier = Modifier.tagged(Tags.Worker.SEND_HOME)) {
            Icon(OfficeIcons.Door, "Send home", tint = Palette.Danger)
        }
    }
}

@Composable
private fun Actions(w: WorkerInfo, lead: (@Composable () -> Unit)? = null, resumable: Boolean = true) {
    val graph = LocalGraph.current
    val data by graph.connection.data.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    val pr = Workers.pr(w, data.pullsForWorker(w.id))
    val branch = w.worktree?.branch?.takeIf { it.isNotBlank() }
    val square = lead != null
    Row(
        Modifier.fillMaxWidth().then(if (lead != null) Modifier.tagged(Tags.Worker.THREAD_BAR) else Modifier)
            .horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        lead?.invoke()
        if (w.state.asleep && resumable) ActionChip(OfficeIcons.Bolt, "Resume", Palette.Accent, Tags.Worker.RESUME, square = square) { graph.connection.send(ClientMsg.resume(w.id)) }
        when (pr?.first) {
            Workers.PrState.Open -> ActionChip(OfficeIcons.PullRequest, "PR #${pr.second.number}", Palette.Success, Tags.Worker.PR, square = square) { if (pr.second.url.isNotBlank()) uri.openUri(pr.second.url) }
            Workers.PrState.Merged -> ActionChip(OfficeIcons.PullRequest, "#${pr.second.number} merged", Color(0xFFB689EF), Tags.Worker.PR, square = square) { if (pr.second.url.isNotBlank()) uri.openUri(pr.second.url) }
            Workers.PrState.Opening -> ActionChip(OfficeIcons.PullRequest, "Opening PR…", Palette.Warning, Tags.Worker.PR, loading = true, square = square) {}
            null -> if (branch != null && !w.isShell) ActionChip(OfficeIcons.PullRequest, "Open PR", Palette.Text, Tags.Worker.PR, square = square) { graph.connection.send(ClientMsg.pr(w.id)) }
        }
        if (branch != null) ActionChip(OfficeIcons.Branch, branch, Palette.TextSecondary, Tags.Worker.BRANCH, square = square, onClick = null)
    }
}

@Composable
private fun ActionChip(icon: ImageVector, text: String, color: Color, tag: String, loading: Boolean = false, square: Boolean = false, onClick: (() -> Unit)?) {
    val haptics = LocalHapticFeedback.current
    val shape = RoundedCornerShape(if (square) 4.dp else 8.dp)
    Row(
        Modifier.clip(shape).background(Palette.Surface).border(1.dp, if (onClick != null) color.copy(alpha = 0.35f) else Palette.Border, shape)
            .then(if (onClick != null) Modifier.clickable { haptics.performHapticFeedback(HapticFeedbackType.ContextClick); onClick() } else Modifier)
            .tagged(tag)
            .padding(horizontal = 10.dp, vertical = 7.dp)
            .widthIn(max = 240.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) Spinner(Modifier.size(13.dp), color) else Icon(icon, null, Modifier.size(14.dp), tint = color)
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = if (onClick != null) color else Palette.TextSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Offline(phase: Phase, thread: Boolean, composing: Boolean) {
    AnimatedVisibility(phase != Phase.Connected, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Row(Modifier.fillMaxWidth().tagged(Tags.Worker.OFFLINE).padding(horizontal = 14.dp, vertical = 4.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.height(18.dp), contentAlignment = Alignment.Center) {
                if (phase == Phase.Connecting || phase == Phase.Reconnecting) Spinner(Modifier.size(12.dp), Palette.Warning)
                else Box(Modifier.size(7.dp).background(Palette.TextSecondary, RoundedCornerShape(1.dp)))
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                val last = if (thread) "This is the last of the thread the office sent." else "This is the last screen the office sent."
                Text(
                    when (phase) {
                        Phase.Offline -> "No network. $last"
                        Phase.Unauthorized -> "The office no longer lets this phone in."
                        else -> "Reconnecting. $last"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.Warning,
                )
                if (composing) Text(
                    "Send is off, and nothing is sent later on its own. Your message stays here.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.Warning,
                    modifier = Modifier.tagged(Tags.Worker.COMPOSER_OFFLINE),
                )
            }
        }
    }
}

@Composable
private fun CloudError(w: WorkerInfo, error: String) {
    Text(
        "☁ ${w.name.ifBlank { "It" }} can't work right now: ${error.trimEnd('.')}. Send is off.",
        style = MaterialTheme.typography.bodySmall,
        color = Palette.Danger,
        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.CLOUD_ERROR).padding(horizontal = 14.dp, vertical = 6.dp),
    )
}

@Composable
private fun Asleep(w: WorkerInfo) {
    val graph = LocalGraph.current
    Box(Modifier.fillMaxSize().tagged(Tags.Worker.ASLEEP).background(Color(0xB3000000), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
            Icon(OfficeIcons.Moon, null, Modifier.size(28.dp), tint = Palette.TextSecondary)
            Spacer(Modifier.height(8.dp))
            Text("${w.name} is asleep", style = MaterialTheme.typography.titleMedium)
            Text(
                "The shell exited. Resume starts a new one at the same desk.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.widthIn(max = 300.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))
            SecondaryButton("Resume", { graph.connection.send(ClientMsg.resume(w.id)) }, Modifier.tagged(Tags.Worker.ASLEEP_RESUME), icon = OfficeIcons.Bolt, color = Palette.Accent)
        }
    }
}

@Composable
private fun Gone(synced: Boolean, embedded: Boolean, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().tagged(Tags.Worker.GONE)) {
        Row(Modifier.padding(4.dp)) {
            IconButton(onClick = onBack, modifier = Modifier.tagged(Tags.Worker.BACK)) { Icon(if (embedded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        }
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            if (!synced) {
                Spinner(Modifier.size(24.dp))
            } else {
                Box(Modifier.size(56.dp).background(Palette.SurfaceRaised, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(OfficeIcons.Door, null, tint = Palette.TextSecondary)
                }
                Spacer(Modifier.height(12.dp))
                Text("This worker went home", style = MaterialTheme.typography.titleLarge)
                Text("Its desk is free again, or it's on another floor.", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(16.dp))
                SecondaryButton("Back to the office", onBack, Modifier.tagged(Tags.Worker.GONE_BACK))
            }
        }
    }
}

/** Shell quick keys: Phone fit, Direct keyboard input, and shell shortcuts (`Tab`, `Ctrl+C`, `git status`, etc.). */
@Composable
private fun QuickKeyRow(workerId: String, phone: Boolean, directInput: Boolean, connected: Boolean, kittyFlags: Int, onPhone: () -> Unit, onDirect: () -> Unit) {
    val graph = LocalGraph.current
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier.fillMaxWidth().tagged(Tags.Worker.KEYS).horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        QuickKey("Phone", "Resize the terminal for this phone", Tags.Worker.PHONE, selected = phone, checked = phone) {
            haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
            onPhone()
        }
        QuickKey("Direct", "Type directly into the terminal", Tags.Worker.DIRECT_INPUT, selected = directInput, checked = directInput, enabled = connected || directInput) {
            haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
            onDirect()
        }
        QuickKeys.shell.forEach { key ->
            QuickKey(key.label, key.spoken, Tags.Worker.key(key.spoken), accent = key.bytes == Keys.ENTER) {
                haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
                graph.connection.send(ClientMsg.termInput(workerId, QuickKeys.bytes(key, kittyFlags)))
            }
        }
    }
}

@Composable
private fun QuickKey(label: String, spoken: String, tag: String, accent: Boolean = false, selected: Boolean = false, checked: Boolean? = null, icon: ImageVector? = null, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(7.dp)
    val interaction = if (checked == null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier.toggleable(checked, enabled = enabled, role = Role.Switch) { onClick() }
    Box(
        Modifier.height(34.dp).widthIn(min = 40.dp).clip(shape)
            .background(if (accent) Palette.AccentMuted else if (selected) Palette.SurfaceHigh else Palette.SurfaceRaised)
            .border(1.dp, if (accent) Palette.Accent.copy(alpha = 0.5f) else Palette.BorderStrong, shape)
            .then(interaction)
            .clearAndSetSemantics {
                contentDescription = spoken
                role = if (checked == null) Role.Button else Role.Switch
                this.selected = selected
                if (checked != null) toggleableState = ToggleableState(checked)
                testTagsAsResourceId = true
                testTag = tag
            }
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = Palette.TextSecondary, modifier = Modifier.size(16.dp))
        } else {
            Text(label, style = LocalOfficeType.current.monoBody.copy(fontSize = 13.sp, color = if (accent) Palette.Accent else Palette.Text))
        }
    }
}

@Composable
private fun MetaLine(parts: List<String>, modifier: Modifier, spoken: String = parts.joinToString(" · "), mark: (@Composable () -> Unit)? = null, markAfter: Int = 0) {
    val style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 15.sp, color = Palette.TextSecondary)
    Layout(
        content = {
            parts.forEachIndexed { i, part ->
                if (i > 0) Text(" · ", style = style, maxLines = 1)
                if (mark != null && i == markAfter) Row(verticalAlignment = Alignment.CenterVertically) { Text(part, style = style); mark() } else Text(part, style = style)
            }
        },
        modifier = modifier.clearAndSetSemantics { text = AnnotatedString(spoken) },
    ) { measurables, constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val placeables = measurables.map { it.measure(loose) }
        val positions = arrayOfNulls<IntOffset>(placeables.size)
        var x = 0
        var y = 0
        var lineHeight = 0
        var width = 0
        for (i in placeables.indices step 2) {
            val part = placeables[i]
            val separator = placeables.getOrNull(i - 1)
            if (separator != null && x + separator.width + part.width > constraints.maxWidth) {
                y += lineHeight
                x = 0
                lineHeight = 0
            } else if (separator != null) {
                positions[i - 1] = IntOffset(x, y)
                x += separator.width
            }
            positions[i] = IntOffset(x, y)
            x += part.width
            lineHeight = maxOf(lineHeight, part.height)
            width = maxOf(width, x)
        }
        layout(width.coerceIn(constraints.minWidth, constraints.maxWidth), (y + lineHeight).coerceAtLeast(constraints.minHeight)) {
            placeables.forEachIndexed { i, p -> positions[i]?.let { p.place(it) } }
        }
    }
}
