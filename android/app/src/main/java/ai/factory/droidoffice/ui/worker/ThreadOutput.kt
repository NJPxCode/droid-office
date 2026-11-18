package ai.factory.droidoffice.ui.worker

import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.ui.LocalGraph
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.LocalOfficeType
import ai.factory.droidoffice.ui.theme.ThreadPalette
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun FullToolOutput(entry: ThreadEntry?) {
    val ref = entry?.outputRef ?: return
    val source = LocalPictureSource.current ?: return
    var open by remember(source, ref) { mutableStateOf(false) }
    TextButton(onClick = { open = true }, modifier = Modifier.tagged(Tags.Worker.threadOutput(entry.id))) {
        Text("Show full output")
    }
    if (open) ToolOutputSheet(source, ref) { open = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ToolOutputSheet(source: PictureSource, ref: String, onDismiss: () -> Unit) {
    val connection = LocalGraph.current.connection
    var chunks by remember(source, ref) { mutableStateOf<List<String>?>(null) }
    var loading by remember(source, ref) { mutableStateOf(true) }
    LaunchedEffect(source, ref) {
        chunks = connection.threadOutput(source.floor, source.worker, ref)?.let(::outputChunks)
        loading = false
    }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = ThreadPalette.Surface) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).tagged(Tags.Worker.THREAD_OUTPUT_SHEET).padding(horizontal = 16.dp)) {
            Text("Full tool output", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 12.dp))
            val content = chunks
            if (content == null) {
                Text(if (loading) "Loading output…" else "Couldn’t load the output. Close and try again.")
            } else {
                val style = LocalOfficeType.current.monoBody.copy(fontSize = 11.sp, lineHeight = 16.sp)
                SelectionContainer {
                    LazyColumn {
                        items(content) { chunk -> Text(chunk, style = style, modifier = Modifier.fillMaxWidth()) }
                    }
                }
            }
        }
    }
}

/** Lay out at most a small part of a large tool result at a time. Prefer to split at newlines. */
private fun outputChunks(text: String): List<String> = buildList {
    var start = 0
    while (start < text.length) {
        val limit = minOf(start + 4096, text.length)
        val line = if (limit < text.length) text.lastIndexOf('\n', limit - 1) else -1
        if (line >= start) {
            add(text.substring(start, line))
            start = line + 1
        } else {
            val end = if (limit < text.length && text[limit - 1].isHighSurrogate()) limit - 1 else limit
            add(text.substring(start, end))
            start = end
        }
    }
}
