package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.ActivePlan
import ai.factory.droidoffice.core.ActivityState
import ai.factory.droidoffice.core.DiffLineKind
import ai.factory.droidoffice.core.FileChangeKind
import ai.factory.droidoffice.core.Markdown
import ai.factory.droidoffice.core.PlanStep
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadBlock
import ai.factory.droidoffice.core.ThreadCardKind
import ai.factory.droidoffice.core.ThreadDiffLine
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadFileChange
import ai.factory.droidoffice.core.ThreadModelAction
import ai.factory.droidoffice.core.ThreadRow
import ai.factory.droidoffice.core.ThreadToolGroup
import ai.factory.droidoffice.core.ThreadTurnChanges
import ai.factory.droidoffice.core.ThreadView
import ai.factory.droidoffice.core.WorkerInfo
import ai.factory.droidoffice.ui.components.Eyebrow
import ai.factory.droidoffice.ui.components.Spinner
import ai.factory.droidoffice.ui.components.panel
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.OfficeIcons
import ai.factory.droidoffice.ui.theme.ThreadPalette
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/**
 * Everything the worker did between two messages: consecutive thoughts and read/search exploration
 * fold into compact 1-level disclosures, while File Change, Command and Delegation cards surface
 * directly in turn order.
 */
@Composable
internal fun Activity(
    a: ThreadRow.Activity,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    asking: Boolean,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    floorDir: String?,
    onToggleExploration: (ThreadView.Segment.Exploration, Boolean) -> Unit,
    onFlip: (String, Boolean) -> Unit,
) {
    val first = a.id.removePrefix("activity:")
    val items = remember(a) { ThreadView.items(a, ThreadView.segments(a)) }
    @Composable
    fun SegmentView(seg: ThreadView.Segment) {
        when (seg) {
            is ThreadView.Segment.Exploration -> {
                val segOpen = ThreadView.Open.exploration(seg, a.open, open)
                ExplorationDisclosure(
                    seg = seg,
                    isOpen = segOpen,
                    open = open,
                    loaded = loaded,
                    asking = asking,
                    onToggle = { onToggleExploration(seg, a.open) },
                    onFlip = onFlip,
                )
            }
            is ThreadView.Segment.Card -> {
                CardSegment(
                    seg = seg,
                    open = open,
                    loaded = loaded,
                    allWorkers = allWorkers,
                    deskWorker = deskWorker,
                    onOpenWorker = onOpenWorker,
                    floorDir = floorDir,
                    onFlip = onFlip,
                )
            }
        }
    }
    Column(
        Modifier.fillMaxWidth().tagged(Tags.Worker.threadGroup(first)),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (item in items) {
            when (item) {
                is ThreadView.Item.One -> SegmentView(item.segment)
                is ThreadView.Item.Group -> {
                    val groupOpen = ThreadView.Open.group(item.group, open)
                    CardGroup(item.group, working = item.group.live && a.live && !asking, isOpen = groupOpen, onToggle = { onFlip(item.group.id, groupOpen) }) {
                        for (seg in item.segments) SegmentView(seg)
                    }
                }
            }
        }
        a.turnChanges?.let { TurnChanges(a.id, it, floorDir, Modifier.padding(top = 2.dp)) }
    }
}

/** Three or more cards in a run, under one line saying what they did and changed; open in the latest turn. */
@Composable
private fun CardGroup(group: ThreadToolGroup, working: Boolean, isOpen: Boolean, onToggle: () -> Unit, content: @Composable () -> Unit) {
    val reveal = rememberReveal()
    val tag = group.id.removePrefix("group:tools:")
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadCardGroup(tag))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadCardGroupToggle(tag)).heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (working) Spinner(Modifier.size(11.dp), ThreadPalette.Accent)
            Text(
                if (working) ThreadView.WORKING + group.label else group.label,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp, color = ThreadPalette.TextSecondary),
                maxLines = if (isOpen) 3 else 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (group.files > 0) {
                Text(filesWord(group.files), style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = ThreadPalette.TextTertiary), maxLines = 1)
                DiffCounts(group.additions, group.deletions)
            }
            if (!working) CardStatusBadge(group.state, quietComplete = true)
            Icon(OfficeIcons.Chevron, null, Modifier.size(14.dp).rotate(if (isOpen) 90f else 0f), tint = ThreadPalette.TextTertiary)
        }
        if (isOpen) {
            Column(
                Modifier.fillMaxWidth().padding(start = 7.dp, bottom = 4.dp).drawBehind {
                    drawLine(ThreadPalette.BorderStrong, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
                }.padding(start = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) { content() }
        }
    }
}

private fun filesWord(count: Int) = if (count == 1) "1 file" else "$count files"

@Composable
private fun DiffCounts(additions: Int, deletions: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("+$additions", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = ThreadPalette.Add))
        Text("-$deletions", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = ThreadPalette.Del))
    }
}

/** What a finished turn changed, under its last message or Activity: each file opens in the file preview where there is one. */
@Composable
internal fun TurnChanges(rowId: String, changes: ThreadTurnChanges, floorDir: String?, modifier: Modifier = Modifier) {
    val preview = LocalFilePreview.current
    Column(modifier.fillMaxWidth().panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.BorderStrong).tagged(Tags.Worker.threadTurnChanges(rowId))) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Changed ${filesWord(changes.count)}", style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp, color = ThreadPalette.TextSecondary), modifier = Modifier.weight(1f))
            DiffCounts(changes.additions, changes.deletions)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.BorderStrong))
        Column(Modifier.padding(vertical = 4.dp)) {
            changes.files.forEachIndexed { i, file ->
                val rel = remember(file.path, floorDir) { ThreadView.workspacePath(file.path, floorDir) }
                val openFile: (() -> Unit)? = if (preview != null && rel != null) {
                    { preview.openFilePreview(rel) }
                } else null
                Row(
                    Modifier.fillMaxWidth()
                        .then(if (openFile != null) Modifier.clickable(onClickLabel = "Open file", role = Role.Button, onClick = openFile) else Modifier)
                        .tagged(Tags.Worker.threadTurnFile(rowId, i))
                        .heightIn(min = 36.dp)
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        file.shortPath,
                        style = LocalOfficeType.current.monoBody.copy(
                            fontSize = 12.sp, lineHeight = 16.sp, color = ThreadPalette.Text,
                            textDecoration = if (openFile != null) TextDecoration.Underline else null,
                        ),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    DiffCounts(file.additions, file.deletions)
                }
            }
            val more = changes.count - changes.files.size
            if (more > 0) {
                Text("and $more more", style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary), modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
            }
        }
    }
}

/** A command as the shell reads it, after an accent prompt. */
private fun shellLine(command: String): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(color = ThreadPalette.Accent)) { append("$ ") }
    for (tok in Markdown.tokenizeCode(command, "sh")) {
        val color = when (tok.kind) {
            Markdown.TokenKind.Plain -> null
            Markdown.TokenKind.Keyword -> ThreadPalette.AccentHover
            Markdown.TokenKind.Type -> ThreadPalette.Info
            Markdown.TokenKind.String -> ThreadPalette.Success
            Markdown.TokenKind.Number -> ThreadPalette.Warning
            Markdown.TokenKind.Comment -> ThreadPalette.TextSecondary
        }
        if (color == null) append(tok.text) else withStyle(SpanStyle(color = color)) { append(tok.text) }
    }
}

@Composable
private fun ExplorationDisclosure(
    seg: ThreadView.Segment.Exploration,
    isOpen: Boolean,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    asking: Boolean,
    onToggle: () -> Unit,
    onFlip: (String, Boolean) -> Unit,
) {
    val working = seg.live && !asking
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).disclosure(isOpen) {
                if (!isOpen) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadGroupToggle(seg.tagId)).heightIn(min = 40.dp).padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (working) {
                Spinner(Modifier.size(11.dp), ThreadPalette.Accent)
                Spacer(Modifier.width(8.dp))
            }
            Text(
                if (working) ThreadView.WORKING + seg.label else seg.label,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp, color = ThreadPalette.TextSecondary),
                maxLines = if (isOpen) 3 else 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).tagged(Tags.Worker.threadGroupSummary(seg.tagId)),
            )
            seg.status?.let {
                Text(
                    it.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary),
                    maxLines = 1, modifier = Modifier.padding(start = 10.dp).tagged(Tags.Worker.threadGroupStatus(seg.tagId)),
                )
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(14.dp).rotate(if (isOpen) 90f else 0f), tint = ThreadPalette.TextTertiary)
        }
        seg.running?.let {
            Text(
                it, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = ThreadPalette.TextTertiary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 24.dp, bottom = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.tagged(Tags.Worker.threadGroupRunning(seg.tagId)),
            )
        }
        if (isOpen) {
            Column(
                Modifier.fillMaxWidth().padding(start = 7.dp, bottom = 4.dp).drawBehind {
                    drawLine(ThreadPalette.BorderStrong, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx())
                }.padding(start = 12.dp),
            ) {
                for (block in seg.blocks) {
                    when (block) {
                        is ThreadBlock.Thought -> {
                            val thoughtOpen = ThreadView.Open.block(block, open)
                            ThoughtRow(block, ThreadView.thought(block, loaded[block.id]), thoughtOpen) { onFlip(block.id, thoughtOpen) }
                        }
                        is ThreadBlock.Tools -> {
                            for (action in block.actions) {
                                val actionOpen = ThreadView.Open.action(action, open)
                                ActionRow(action, loaded[action.id], actionOpen) { onFlip(action.id, actionOpen) }
                            }
                            block.plan?.let { Plan(Tags.Worker.threadRunPlan(block.id.removePrefix("tools:")), it) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CardSegment(
    seg: ThreadView.Segment.Card,
    open: SnapshotStateMap<String, Boolean>,
    loaded: Map<String, ThreadEntry>,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    floorDir: String?,
    onFlip: (String, Boolean) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (action in seg.block.actions) {
            when (seg.kind) {
                ThreadCardKind.Change -> {
                    val changes = action.changes
                    if (changes.isNullOrEmpty()) {
                        val actionOpen = ThreadView.Open.action(action, open)
                        ActionRow(action, loaded[action.id], actionOpen) { onFlip(action.id, actionOpen) }
                    } else {
                        Column(Modifier.fillMaxWidth().tagged(Tags.Worker.threadEntry(action.id)), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            changes.forEachIndexed { idx, change ->
                                val changeKey = if (changes.size == 1) action.id else "${action.id}:$idx"
                                val isOpen = ThreadView.Open.change(changeKey, change, open)
                                val fullKey = DIFF_FULL + changeKey
                                val showFull = open[fullKey] == true
                                FileChangeCard(
                                    action = action,
                                    change = change,
                                    changeKey = changeKey,
                                    entry = loaded[action.id],
                                    floorDir = floorDir,
                                    isOpen = isOpen,
                                    showFull = showFull,
                                    onToggle = { onFlip(changeKey, isOpen) },
                                    onToggleFull = { onFlip(fullKey, showFull) },
                                )
                            }
                        }
                    }
                }
                ThreadCardKind.Command -> {
                    val isOpen = ThreadView.Open.command(action, open)
                    CommandCard(action, loaded[action.id], isOpen) { onFlip(action.id, isOpen) }
                }
                ThreadCardKind.Delegate -> {
                    val isOpen = ThreadView.Open.action(action, open)
                    DelegationCard(
                        action = action,
                        entry = loaded[action.id],
                        isOpen = isOpen,
                        allWorkers = allWorkers,
                        deskWorker = deskWorker,
                        onOpenWorker = onOpenWorker,
                        onToggle = { onFlip(action.id, isOpen) },
                    )
                }
            }
        }
    }
}

@Composable
private fun FileChangeCard(
    action: ThreadModelAction,
    change: ThreadFileChange,
    changeKey: String,
    entry: ThreadEntry?,
    floorDir: String?,
    isOpen: Boolean,
    showFull: Boolean,
    onToggle: () -> Unit,
    onToggleFull: () -> Unit,
) {
    val reveal = rememberReveal()
    val preview = LocalFilePreview.current
    val relPath = remember(change.path, floorDir) { ThreadView.workspacePath(change.path, floorDir) }
    val openFile: (() -> Unit)? = if (preview != null && relPath != null) {
        { preview.openFilePreview(relPath, ThreadView.targetLine(change)) }
    } else null
    val borderColor = if (action.state == ActivityState.Failed) ThreadPalette.Danger.copy(alpha = 0.35f) else ThreadPalette.BorderStrong
    Column(
        Modifier.fillMaxWidth()
            .then(reveal.modifier)
            .panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, borderColor)
            .tagged(Tags.Worker.threadChange(changeKey)),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .disclosure(isOpen) {
                    if (!isOpen) reveal.ask()
                    onToggle()
                }
                .tagged(Tags.Worker.threadToggle(changeKey))
                .heightIn(min = 42.dp)
                .padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            if (action.state == ActivityState.Working) {
                Spinner(Modifier.size(11.dp), ThreadPalette.Accent)
            } else {
                Icon(OfficeIcons.File, null, Modifier.size(13.dp), tint = ThreadPalette.TextSecondary)
            }
            Text(
                change.shortPath,
                style = LocalOfficeType.current.monoBody.copy(
                    fontSize = 12.5.sp, lineHeight = 17.sp, color = ThreadPalette.Text,
                    textDecoration = if (openFile != null) TextDecoration.Underline else null,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).then(
                    if (openFile != null) {
                        Modifier.clickable(onClickLabel = "Open file", role = Role.Button, onClick = openFile).tagged(Tags.Worker.threadChangeOpen(changeKey))
                    } else Modifier,
                ),
            )
            when (change.kind) {
                FileChangeKind.Added -> MiniBadge("ADDED", ThreadPalette.Add)
                FileChangeKind.Deleted -> MiniBadge("DELETED", ThreadPalette.Del)
                FileChangeKind.Modified -> if (change.generated && !isOpen) MiniBadge("GENERATED", ThreadPalette.TextSecondary)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("+${change.additions}", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = ThreadPalette.Add))
                Text("-${change.deletions}", style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, color = ThreadPalette.Del))
            }
            CardStatusBadge(action.state, quietComplete = false)
            Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) 90f else 0f), tint = ThreadPalette.TextSecondary)
        }
        if (openFile != null && change.kind == FileChangeKind.Added && action.state == ActivityState.Complete && ThreadView.deliverable(change.path)) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.Border))
            Row(
                Modifier.clickable(onClickLabel = "Preview the file", role = Role.Button, onClick = openFile)
                    .tagged(Tags.Worker.threadChangePreview(changeKey))
                    .heightIn(min = 40.dp)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(OfficeIcons.File, null, Modifier.size(12.dp), tint = ThreadPalette.Text)
                Text("PREVIEW", style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.Text))
            }
        }
        if (isOpen) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.BorderStrong))
            if (change.lines.isNotEmpty()) {
                val canClamp = change.lines.size > ThreadView.DIFF_CLAMP_LINES
                val shownLines = if (canClamp && !showFull) change.lines.take(ThreadView.DIFF_CLAMP_LINES) else change.lines
                val formatted = remember(shownLines) { formatDiffLines(shownLines) }
                var textLayout by remember(shownLines) { mutableStateOf<TextLayoutResult?>(null) }
                CodeScroll(ThreadPalette.Bg, bordered = false) { scroll ->
                    SelectionContainer {
                        Text(
                            formatted,
                            style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 17.sp),
                            softWrap = false,
                            onTextLayout = { textLayout = it },
                            modifier = scroll
                                .drawBehind {
                                    val layout = textLayout ?: return@drawBehind
                                    val vPad = 6.dp.toPx()
                                    val count = minOf(shownLines.size, layout.lineCount)
                                    for (idx in 0 until count) {
                                        val bg = when (shownLines[idx].kind) {
                                            DiffLineKind.Add -> ThreadPalette.AddRow
                                            DiffLineKind.Del -> ThreadPalette.DelRow
                                            DiffLineKind.Hunk -> ThreadPalette.Info.copy(alpha = 0.07f)
                                            else -> Color.Transparent
                                        }
                                        if (bg != Color.Transparent) {
                                            val top = vPad + layout.getLineTop(idx)
                                            val bottom = vPad + layout.getLineBottom(idx)
                                            drawRect(bg, topLeft = Offset(0f, top), size = androidx.compose.ui.geometry.Size(size.width, bottom - top))
                                        }
                                    }
                                }
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
                if (canClamp) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.Border))
                    Row(
                        Modifier.fillMaxWidth()
                            .background(ThreadPalette.SurfaceRaised)
                            .disclosure(showFull, onToggleFull)
                            .tagged(Tags.Worker.threadChangeFull(changeKey))
                            .heightIn(min = 34.dp)
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (showFull) "SHOW LESS" else "SHOW FULL DIFF (${change.lines.size} LINES)",
                            style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.Text),
                        )
                        Spacer(Modifier.width(6.dp))
                        Icon(OfficeIcons.Chevron, null, Modifier.size(12.dp).rotate(if (showFull) -90f else 90f), tint = ThreadPalette.TextSecondary)
                    }
                } else if (change.truncated) {
                    Text(
                        "Showing the first ${change.lines.size} diff lines.",
                        style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary),
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            } else if (action.state == ActivityState.Failed) {
                ActionDetailsBody(action, entry, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
            } else {
                Text(
                    if (change.generated) "Generated file updated." else "No line changes to display.",
                    style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextSecondary),
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
        }
    }
}

private fun formatDiffLines(lines: List<ThreadDiffLine>): AnnotatedString {
    // An Edit the office couldn't place in its file has no line numbers: no gutter rather than made-up ones.
    val numbered = lines.any { it.oldLine != null || it.newLine != null }
    val maxLine = lines.maxOfOrNull { maxOf(it.oldLine ?: 0, it.newLine ?: 0) } ?: 0
    val digits = maxLine.toString().length.coerceAtLeast(2)
    val blankNum = " ".repeat(digits)
    return buildAnnotatedString {
        lines.forEachIndexed { idx, line ->
            val clean = line.text.replace('\n', ' ').replace('\r', ' ')
            if (!numbered) {
                val (sign, color) = when (line.kind) {
                    DiffLineKind.Add -> "+ " to ThreadPalette.Add
                    DiffLineKind.Del -> "- " to ThreadPalette.Del
                    DiffLineKind.Ctx -> "  " to ThreadPalette.TextTertiary
                    DiffLineKind.Hunk -> "" to ThreadPalette.Info
                    DiffLineKind.Note -> "" to ThreadPalette.TextSecondary
                }
                withStyle(SpanStyle(color = color)) { append(sign) }
                val body = when (line.kind) {
                    DiffLineKind.Hunk -> ThreadPalette.Info
                    DiffLineKind.Note, DiffLineKind.Ctx -> ThreadPalette.TextSecondary
                    else -> ThreadPalette.Text
                }
                withStyle(SpanStyle(color = body)) { append(clean) }
                if (idx < lines.lastIndex) append('\n')
                return@forEachIndexed
            }
            when (line.kind) {
                DiffLineKind.Hunk, DiffLineKind.Note -> {
                    val gutter = if (line.kind == DiffLineKind.Hunk) ThreadPalette.Info else ThreadPalette.TextSecondary
                    withStyle(SpanStyle(color = gutter)) {
                        append("$blankNum $blankNum   $clean")
                    }
                }
                DiffLineKind.Add -> {
                    val newNum = (line.newLine?.toString() ?: "").padStart(digits)
                    withStyle(SpanStyle(color = ThreadPalette.Add)) {
                        append("$blankNum $newNum + ")
                    }
                    withStyle(SpanStyle(color = ThreadPalette.Text)) { append(clean) }
                }
                DiffLineKind.Del -> {
                    val oldNum = (line.oldLine?.toString() ?: "").padStart(digits)
                    withStyle(SpanStyle(color = ThreadPalette.Del)) {
                        append("$oldNum $blankNum - ")
                    }
                    withStyle(SpanStyle(color = ThreadPalette.Text)) { append(clean) }
                }
                DiffLineKind.Ctx -> {
                    val oldNum = (line.oldLine?.toString() ?: "").padStart(digits)
                    val newNum = (line.newLine?.toString() ?: "").padStart(digits)
                    withStyle(SpanStyle(color = ThreadPalette.TextTertiary)) {
                        append("$oldNum $newNum   ")
                    }
                    withStyle(SpanStyle(color = ThreadPalette.TextSecondary)) { append(clean) }
                }
            }
            if (idx < lines.lastIndex) append('\n')
        }
    }
}

@Composable
private fun CommandCard(action: ThreadModelAction, entry: ThreadEntry?, isOpen: Boolean, onToggle: () -> Unit) {
    val reveal = rememberReveal()
    val cmdText = action.command?.command?.takeIf { it.isNotBlank() } ?: action.detail?.takeIf { it.isNotBlank() } ?: action.title
    val summaryText = action.command?.summary?.takeIf { it.isNotBlank() && it != cmdText }
    val borderColor = if (action.state == ActivityState.Failed) ThreadPalette.Danger.copy(alpha = 0.4f) else ThreadPalette.BorderStrong
    Column(
        Modifier.fillMaxWidth()
            .then(reveal.modifier)
            .panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, borderColor)
            .tagged(Tags.Worker.threadEntry(action.id)),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f)
                    .disclosure(isOpen) {
                        if (!isOpen) reveal.ask()
                        onToggle()
                    }
                    .tagged(Tags.Worker.threadToggle(action.id))
                    .heightIn(min = 42.dp)
                    .padding(start = 10.dp, top = 7.dp, bottom = 7.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (action.state == ActivityState.Working) {
                    Spinner(Modifier.size(11.dp), ThreadPalette.Accent)
                } else {
                    Icon(
                        OfficeIcons.Shell,
                        null,
                        Modifier.size(13.dp),
                        tint = if (action.state == ActivityState.Failed) ThreadPalette.Danger else ThreadPalette.TextSecondary,
                    )
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        remember(cmdText) { shellLine(cmdText) },
                        style = LocalOfficeType.current.monoBody.copy(fontSize = 12.5.sp, lineHeight = 17.sp, color = ThreadPalette.Text),
                        maxLines = if (isOpen) 4 else 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    summaryText?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp, color = ThreadPalette.TextSecondary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                CardStatusBadge(action.state, quietComplete = true)
                Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) 90f else 0f), tint = ThreadPalette.TextSecondary)
            }
            DisableSelection {
                CopyActionChip(
                    label = "Copy command",
                    textToCopy = cmdText,
                    clipTitle = "Command",
                    tag = Tags.Worker.threadCommandCopy(action.id),
                    iconOnly = true,
                    modifier = Modifier.padding(end = 6.dp),
                )
            }
        }
        if (isOpen) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.BorderStrong))
            ActionDetailsBody(action, entry, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
        }
    }
}

@Composable
private fun DelegationCard(
    action: ThreadModelAction,
    entry: ThreadEntry?,
    isOpen: Boolean,
    allWorkers: List<WorkerInfo>,
    deskWorker: (String) -> WorkerInfo?,
    onOpenWorker: ((String) -> Unit)?,
    onToggle: () -> Unit,
) {
    val reveal = rememberReveal()
    val del = action.delegation
    val matchedWorker = remember(del, allWorkers) {
        if (del == null) null
        else del.workerId?.let(deskWorker)
            ?: del.workerName?.let { name -> allWorkers.firstOrNull { it.name.equals(name, ignoreCase = true) } }
    }
    val agentName = del?.agent?.ifBlank { null } ?: "Subagent"
    val metaParts = remember(del, agentName) {
        listOfNotNull(
            del?.role?.takeIf { it.isNotBlank() && !it.equals(agentName, ignoreCase = true) },
            del?.branch?.takeIf { it.isNotBlank() },
        )
    }
    Column(
        Modifier.fillMaxWidth()
            .then(reveal.modifier)
            .panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.BorderStrong)
            .tagged(Tags.Worker.threadEntry(action.id)),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth()
                    .disclosure(isOpen) {
                        if (!isOpen) reveal.ask()
                        onToggle()
                    }
                    .tagged(Tags.Worker.threadToggle(action.id))
                    .heightIn(min = 44.dp)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (action.state == ActivityState.Working) {
                    Spinner(Modifier.size(12.dp), ThreadPalette.Accent)
                } else {
                    Icon(OfficeIcons.Agent, null, Modifier.size(14.dp), tint = ThreadPalette.Accent)
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(agentName, style = MaterialTheme.typography.titleSmall.copy(fontSize = 13.5.sp, color = ThreadPalette.Text), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (metaParts.isNotEmpty()) {
                            Text(
                                metaParts.joinToString(" · "),
                                style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, color = ThreadPalette.TextSecondary),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Text(
                        del?.summary?.ifBlank { null } ?: action.title,
                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, lineHeight = 18.sp, color = ThreadPalette.TextSecondary),
                        maxLines = if (isOpen) 4 else 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                CardStatusBadge(action.state, quietComplete = false)
                Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) 90f else 0f), tint = ThreadPalette.TextSecondary)
            }
            if (onOpenWorker != null && matchedWorker != null) {
                Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp), horizontalArrangement = Arrangement.End) {
                    val shape = RoundedCornerShape(3.dp)
                    Row(
                        Modifier.clip(shape)
                            .border(1.dp, ThreadPalette.Accent.copy(alpha = 0.45f), shape)
                            .background(ThreadPalette.AccentMuted)
                            .clickable(role = Role.Button) { onOpenWorker(matchedWorker.id) }
                            .tagged(Tags.Worker.threadDelegateOpen(action.id))
                            .heightIn(min = 30.dp)
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(OfficeIcons.Workers, null, Modifier.size(12.dp), tint = ThreadPalette.Accent)
                        Text("OPEN THREAD", style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.Accent))
                    }
                }
            }
        }
        if (isOpen) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(ThreadPalette.Border))
            ActionDetailsBody(action, entry, Modifier.padding(horizontal = 10.dp, vertical = 8.dp))
        }
    }
}

@Composable
private fun MiniBadge(label: String, color: Color) {
    val shape = RoundedCornerShape(3.dp)
    Box(
        Modifier.clip(shape)
            .background(color.copy(alpha = 0.12f))
            .border(1.dp, color.copy(alpha = 0.35f), shape)
            .padding(horizontal = 5.dp, vertical = 1.5.dp),
    ) {
        Text(label, style = LocalOfficeType.current.eyebrow.copy(fontSize = 9.5.sp, color = color))
    }
}

@Composable
private fun CardStatusBadge(state: ActivityState, quietComplete: Boolean) {
    when (state) {
        ActivityState.Working -> MiniBadge("RUNNING", ThreadPalette.Warning)
        ActivityState.Failed -> MiniBadge("FAILED", ThreadPalette.Danger)
        ActivityState.Cancelled -> MiniBadge("CANCELLED", ThreadPalette.TextSecondary)
        ActivityState.Incomplete -> MiniBadge("NO RESULT", ThreadPalette.TextSecondary)
        ActivityState.Complete -> if (quietComplete) Icon(OfficeIcons.Check, null, Modifier.size(12.dp), tint = ThreadPalette.TextTertiary)
    }
}

@Composable
private fun ActionDetailsBody(a: ThreadModelAction, entry: ThreadEntry?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val canShow = LocalPictureSource.current != null
        when (val d = remember(a, entry?.input, entry?.output, entry?.images, canShow) { ThreadView.detail(a, entry, canShow) }) {
            ThreadView.Detail.NotLoaded -> Text(ThreadView.NOT_LOADED, style = MaterialTheme.typography.bodySmall, modifier = Modifier.tagged(Tags.Worker.threadNotLoaded(a.id)))
            is ThreadView.Detail.Shown -> {
                d.arguments?.let { (label, body) -> Mono(label, body, ThreadPalette.Text) }
                val pictures = d.images.isNotEmpty()
                if (d.recorded) {
                    if (d.output.isNotEmpty() || !pictures) {
                        Mono(d.result, d.output.ifEmpty { "(empty)" }, if (a.state == ActivityState.Cancelled) ThreadPalette.TextSecondary else ThreadPalette.Text)
                    }
                    if (pictures) ThreadPictures(d.images, a.title, a.detail, end = false)
                } else {
                    Eyebrow(d.result, color = ThreadPalette.TextSecondary)
                    Text(d.output, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
internal fun StickyPlanBar(plan: ActivePlan, isOpen: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val fraction = if (plan.total > 0) (plan.done.toFloat() / plan.total.toFloat()).coerceIn(0f, 1f) else 0f
    Column(
        modifier
            .panel(RoundedCornerShape(4.dp), ThreadPalette.Surface, ThreadPalette.BorderStrong)
            .tagged(Tags.Worker.THREAD_PLAN),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .disclosure(isOpen, onToggle)
                .tagged(Tags.Worker.THREAD_PLAN_TOGGLE)
                .heightIn(min = 38.dp)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(if (plan.allDone) ThreadPalette.Success else ThreadPalette.Accent))
            Text(
                "${plan.done}/${plan.total} completed",
                style = LocalOfficeType.current.eyebrow.copy(color = if (plan.allDone) ThreadPalette.Success else ThreadPalette.Text),
                maxLines = 1,
            )
            Text(
                plan.current ?: if (plan.allDone) "All steps completed" else "Plan in progress",
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, color = ThreadPalette.TextSecondary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(OfficeIcons.Chevron, null, Modifier.size(13.dp).rotate(if (isOpen) -90f else 90f), tint = ThreadPalette.TextSecondary)
        }
        Box(Modifier.fillMaxWidth().height(2.dp).background(ThreadPalette.SurfaceHigh)) {
            Box(Modifier.fillMaxWidth(fraction).height(2.dp).background(if (plan.allDone) ThreadPalette.Success else ThreadPalette.Accent))
        }
        if (isOpen && plan.steps.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth()
                    .heightIn(max = 180.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                for (s in plan.steps) {
                    Row(verticalAlignment = Alignment.Top) {
                        Text(
                            when {
                                s.done -> "✓"
                                s.active -> "●"
                                else -> "○"
                            },
                            style = LocalOfficeType.current.monoBody.copy(
                                fontSize = 12.sp,
                                color = when {
                                    s.done -> ThreadPalette.Success
                                    s.active -> ThreadPalette.Accent
                                    else -> ThreadPalette.TextTertiary
                                },
                            ),
                            modifier = Modifier.width(18.dp).clearAndSetSemantics {
                                contentDescription = if (s.done) "Done" else if (s.active) "Now" else "Next"
                            },
                        )
                        Text(
                            s.text,
                            style = MaterialTheme.typography.bodySmall.copy(
                                fontSize = 12.5.sp,
                                lineHeight = 18.sp,
                                fontWeight = if (s.active) FontWeight.Medium else FontWeight.Normal,
                                color = if (s.active) ThreadPalette.Text else ThreadPalette.TextSecondary,
                                textDecoration = if (s.done) TextDecoration.LineThrough else null,
                            ),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ActionRow(a: ThreadModelAction, entry: ThreadEntry?, open: Boolean, onToggle: () -> Unit) {
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadEntry(a.id))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(open) {
                if (!open) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadToggle(a.id)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (a.state == ActivityState.Working) {
                Spinner(Modifier.size(10.dp), ThreadPalette.Accent)
                Spacer(Modifier.width(10.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    a.title,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 13.sp, lineHeight = 18.sp,
                        color = when (a.state) {
                            ActivityState.Working -> ThreadPalette.Text
                            else -> ThreadPalette.TextSecondary
                        },
                    ),
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                a.detail?.let {
                    Text(it, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 15.sp, color = ThreadPalette.TextSecondary), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (a.status.isNotEmpty()) {
                Text(
                    a.status.uppercase(), style = LocalOfficeType.current.eyebrow.copy(color = ThreadPalette.TextSecondary),
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(13.dp).rotate(if (open) 90f else 0f), tint = ThreadPalette.TextSecondary)
        }
        if (open) {
            ActionDetailsBody(a, entry, Modifier.padding(start = 22.dp, top = 2.dp, bottom = 10.dp))
        }
    }
}

/** One thought in an open Activity: its first line while closed, the whole of it while open. */
@Composable
private fun ThoughtRow(t: ThreadBlock.Thought, text: String, open: Boolean, onToggle: () -> Unit) {
    val reveal = rememberReveal()
    Column(Modifier.fillMaxWidth().then(reveal.modifier).tagged(Tags.Worker.threadEntry(t.id))) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).disclosure(open) {
                if (!open) reveal.ask()
                onToggle()
            }.tagged(Tags.Worker.threadToggle(t.id)).heightIn(min = 40.dp).padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (t.live) {
                Spinner(Modifier.size(10.dp), ThreadPalette.Accent)
                Spacer(Modifier.width(8.dp))
            }
            Text("Thought", style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, color = ThreadPalette.TextSecondary), maxLines = 1, softWrap = false)
            Box(Modifier.weight(1f)) {
                if (!open) {
                    Text(
                        t.preview, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextTertiary),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
            Icon(OfficeIcons.Chevron, null, Modifier.padding(start = 8.dp).size(13.dp).rotate(if (open) 90f else 0f), tint = ThreadPalette.TextSecondary)
        }
        if (open) {
            SelectionContainer {
                Text(
                    text, style = MaterialTheme.typography.bodySmall.copy(lineHeight = 19.sp),
                    modifier = Modifier.padding(start = 12.dp, bottom = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun Plan(tag: String, steps: List<PlanStep>) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp).tagged(tag)) {        Eyebrow("Plan · ${steps.count { it.done }} of ${steps.size} done", Modifier.padding(bottom = 4.dp), color = ThreadPalette.TextSecondary)
        for (s in steps) {
            Row(Modifier.padding(vertical = 2.dp)) {
                // Marks, not arrows: a › here would read as something to open. Said as the web says them.
                Text(
                    when {
                        s.done -> "✓"
                        s.active -> "●"
                        else -> "○"
                    },
                    style = LocalOfficeType.current.monoBody.copy(fontSize = 12.sp, color = if (s.active) ThreadPalette.Accent else ThreadPalette.TextTertiary),
                    modifier = Modifier.width(18.dp).clearAndSetSemantics { contentDescription = if (s.done) "Done" else if (s.active) "Now" else "Next" },
                )
                Text(
                    s.text,
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 13.sp,
                        color = when {
                            s.done -> ThreadPalette.TextSecondary
                            s.active -> ThreadPalette.Text
                            else -> ThreadPalette.TextSecondary
                        },
                        textDecoration = if (s.done) TextDecoration.LineThrough else null,
                    ),
                )
            }
        }
    }
}

@Composable
private fun Mono(label: String, body: String, color: Color) {
    Eyebrow(label, color = ThreadPalette.TextSecondary)
    val shown = if (body.length > SHOWN_CHARS) body.take(SHOWN_CHARS) else body
    CodeScroll(ThreadPalette.Bg) { scroll ->
        SelectionContainer {
            Text(
                shown, style = LocalOfficeType.current.monoBody.copy(fontSize = 11.5.sp, lineHeight = 16.sp, color = color), softWrap = false,
                modifier = scroll.background(ThreadPalette.Bg, RoundedCornerShape(3.dp)).padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
    }
    if (shown.length < body.length) Text("Showing the first $SHOWN_CHARS of ${body.length} characters. Raw TTY has the rest.", style = MaterialTheme.typography.bodySmall)
}
