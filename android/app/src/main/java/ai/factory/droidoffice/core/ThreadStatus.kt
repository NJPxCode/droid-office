package ai.factory.droidoffice.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Factual live status, matching src/shared/thread-status.ts. */
object ThreadStatus {
    data class Line(val label: String, val since: Long? = null, val detail: String? = null, val waiting: Boolean = false)

    fun line(w: WorkerInfo, live: ThreadLive?, entries: List<ThreadEntry>, skew: Long): Line? {
        if (w.state == WorkerStatus.Starting) return Line("Starting worker…")
        if (!w.state.busy && w.state != WorkerStatus.NeedsInput) return null
        if (w.state == WorkerStatus.NeedsInput || live?.status == ThreadLive.Status.Waiting) {
            val kind = live?.waiting?.kind ?: when {
                live?.working == "waiting_for_tool_confirmation" -> "permission"
                w.menu != null || w.cloud?.menu != null -> "question"
                else -> null
            }
            val reason = when (kind) {
                "permission" -> ": permission needed"
                "question" -> ": answer needed"
                "spec" -> ": review needed"
                else -> ""
            }
            return Line("Waiting for you$reason", waiting = true)
        }
        val since = (live?.phaseSince ?: live?.turnStartedAt ?: w.workingSince)?.plus(skew)
        val detail = live?.label
        if (live?.status == ThreadLive.Status.Compacting || w.activity == "Compacting its conversation") return Line("Compacting conversation…", since, detail)
        val tool = live?.tools?.lastOrNull { it.phase == "running" }
        if (tool != null) return Line("Running: ${toolTitle(tool, entries)}", tool.startedAt + skew, detail)
        if (live?.status == ThreadLive.Status.Responding) return Line("Writing", since, detail)
        if (live?.working == "thinking") return Line("Thinking", since, detail)
        return Line("Working…", since, detail)
    }

    private fun toolTitle(tool: ThreadLive.Tool, entries: List<ThreadEntry>): String {
        if (tool.id != null && tool.name.substringAfterLast('.').substringAfterLast(':').equals("Execute", ignoreCase = true)) {
            val input = entries.firstOrNull { it.id == tool.id && it.kind == ThreadKind.Tool }?.input
            if (input != null) {
                val command = runCatching { (Json.parseToJsonElement(input) as? JsonObject)?.get("command") as? JsonPrimitive }.getOrNull()
                if (command?.isString == true && command.content.isNotBlank()) {
                    return command.content.trim().replace(Whitespace, " ")
                }
            }
        }
        return tool.name
    }

    fun elapsed(since: Long, now: Long): String {
        val seconds = (now - since).coerceAtLeast(0) / 1000
        return if (seconds < 60) "${seconds}s" else "${seconds / 60}m ${seconds % 60}s"
    }

    private val Whitespace = Regex("\\s+")
}
