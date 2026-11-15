package ai.factory.droidoffice.ui.worker

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.factory.droidoffice.core.Tags
import ai.factory.droidoffice.core.ThreadActions
import ai.factory.droidoffice.ui.components.tagged
import ai.factory.droidoffice.ui.theme.ThreadPalette

/** Factory's rewind confirmation with the TUI's file-restoration choice. */
@Composable
internal fun ThreadRewindDialog(
    text: String,
    busy: Boolean,
    error: String?,
    onChoose: (restore: Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    var restore by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        containerColor = ThreadPalette.Surface,
        titleContentColor = ThreadPalette.Text,
        textContentColor = ThreadPalette.TextSecondary,
        title = { Text("Rewind Conversation") },
        text = {
            Column(Modifier.fillMaxWidth().tagged(Tags.Worker.THREAD_REWIND)) {
                Text("Are you sure you want to rewind to this message?", style = MaterialTheme.typography.bodyMedium)
                Text(
                    ThreadActions.preview(text),
                    style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.TextTertiary),
                    modifier = Modifier.padding(top = 10.dp, bottom = 16.dp),
                )
                RestoreChoice(
                    selected = !restore,
                    title = "Don't restore files",
                    description = "Rewind conversation only, keep files as they are",
                    tag = Tags.Worker.THREAD_REWIND_KEEP,
                    enabled = !busy,
                ) { restore = false }
                RestoreChoice(
                    selected = restore,
                    title = "Restore all files",
                    description = "Restore changed files and delete files created after this message",
                    tag = Tags.Worker.THREAD_REWIND_RESTORE,
                    enabled = !busy,
                ) { restore = true }
                if (error != null) {
                    Text(error, style = MaterialTheme.typography.bodySmall.copy(color = ThreadPalette.Danger), modifier = Modifier.padding(top = 12.dp))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onChoose(restore) }, enabled = !busy, modifier = Modifier.tagged(Tags.Worker.THREAD_REWIND_CONFIRM)) {
                Text(if (busy) "Rewinding…" else "Rewind", color = if (busy) ThreadPalette.TextTertiary else ThreadPalette.Accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, enabled = !busy, modifier = Modifier.tagged(Tags.Worker.THREAD_REWIND_CANCEL)) {
                Text("Cancel", color = ThreadPalette.TextSecondary)
            }
        },
    )
}

@Composable
private fun RestoreChoice(selected: Boolean, title: String, description: String, tag: String, enabled: Boolean, onClick: () -> Unit) {
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .tagged(tag).padding(vertical = 8.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Column(Modifier.padding(start = 8.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium.copy(color = ThreadPalette.Text))
            Text(description, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, color = ThreadPalette.TextSecondary))
        }
    }
}
