package ai.factory.droidoffice.ui.worker

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadEntry
import ai.factory.droidoffice.core.ThreadTurns
import ai.factory.droidoffice.ui.LocalSnackbar
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.ThreadPalette
import kotlinx.coroutines.launch

/** Droid's /copy menu: a reply, a prompt, the session id, the transcript or the last turns, to the clipboard. */
@Composable
internal fun ThreadCopyDialog(entries: List<ThreadEntry>, sessionId: String?, initialTurns: String = "1", onDismiss: () -> Unit) {
    val clipboard = LocalClipboard.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    var turns by remember(initialTurns) { mutableStateOf(initialTurns.filter(Char::isDigit).take(4).ifEmpty { "1" }) }
    fun pick(choice: ThreadTurns.Copy) {
        val text = ThreadTurns.copyText(entries, choice, sessionId, turns.toIntOrNull() ?: 1)
        scope.launch {
            if (text == null) {
                snackbar.showSnackbar(if (choice == ThreadTurns.Copy.Session) "This worker has no session yet." else "Nothing to copy yet.")
            } else {
                val copied = runCatching { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(choice.label, text))) }.isSuccess
                if (copied) onDismiss() else snackbar.showSnackbar("Couldn't copy to the clipboard.")
            }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = ThreadPalette.Surface,
        titleContentColor = ThreadPalette.Text,
        title = { Text("Copy") },
        text = {
            Column(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_COPY), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                for (choice in ThreadTurns.Copy.entries) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { pick(choice) }, modifier = Modifier.tagged(Tags.Worker.copyChoice(choice.name))) { Text(choice.label, color = ThreadPalette.Accent) }
                        if (choice == ThreadTurns.Copy.Turns) {
                            Text("Last", color = ThreadPalette.TextSecondary, modifier = Modifier.padding(horizontal = 6.dp))
                            OutlinedTextField(
                                value = turns,
                                onValueChange = { next -> turns = next.filter(Char::isDigit).take(4) },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                modifier = Modifier.width(72.dp),
                            )
                            Text("turns", color = ThreadPalette.TextSecondary, modifier = Modifier.padding(horizontal = 6.dp))
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = ThreadPalette.TextSecondary) } },
    )
}
