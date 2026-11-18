package ai.factory.droidoffice.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** A worker waiting on an AskUser question, with the structured menu the office holds for it. */
data class PendingAsk(val worker: WorkerInfo, val menu: Menu?)

/** Structured AskUser questionnaires: who is waiting on an answer, oldest first, and what to show for each. */
object Asks {
    private val OTHER = Regex("""^other\b|type (your|an?) (own )?answer""", RegexOption.IGNORE_CASE)

    /** Workers waiting on the owner, whoever has waited longest first. */
    fun queue(workers: Collection<WorkerInfo>): List<PendingAsk> =
        workers.filter { it.state == WorkerStatus.NeedsInput && !it.isShell }
            .sortedWith(compareBy<WorkerInfo> { it.waitingSince ?: Long.MAX_VALUE }.thenBy { it.createdAt }.thenBy { it.id })
            .map { w -> PendingAsk(w, menu(w)) }

    /** The structured AskUser menu held by the office (`w.menu` for local Droid and Orchestrator, `w.cloud?.menu` for cloud). */
    fun menu(w: WorkerInfo): Menu? = if (w.isShell) null else w.menu ?: w.cloud?.menu

    /** The thread can answer a waiting Droid worker when the office holds a structured AskUser menu for it. */
    fun canAnswer(w: WorkerInfo): Boolean =
        w.state == WorkerStatus.NeedsInput && !w.isShell && menu(w) != null

    /** Whether [menu] accepts a free-text answer (explicit free-text row or an "Other" / "Type your own answer" option). */
    fun takesText(menu: Menu): Boolean = menu.freeText || menu.choices.any { OTHER.containsMatchIn(it.label) }

    /** Identity comparison across updates: ignores cursor pointer and selection toggles so live drafting stays intact. */
    fun sameMenu(a: Menu?, b: Menu?): Boolean {
        if (a == null || b == null) return false
        if (a.question != b.question || a.multiSelect != b.multiSelect || a.freeText != b.freeText) return false
        if (a.choices.size != b.choices.size) return false
        return a.choices.indices.all { i ->
            val x = a.choices[i]
            val y = b.choices[i]
            x.number == y.number && x.label == y.label && x.description == y.description
        }
    }

    /** One line of what it's on, above the question: its task or title, else the start of its prompt. */
    fun context(w: WorkerInfo): String? =
        (Workers.title(w) ?: w.prompt?.lineSequence()?.firstOrNull { it.isNotBlank() })?.trim()?.take(140)?.takeIf { it.isNotBlank() }

    /**
     * The question to show: the matching open questionnaire entry, else [PendingAsk.menu]'s question,
     * else what the office says it's waiting on. Generic notices ("Factory CLI is asking the user 1
     * question(s)") never stand in.
     */
    fun question(ask: PendingAsk, entries: List<ThreadEntry> = emptyList()): String =
        matching(pending(ask.worker.ask, entries), ask.menu)?.question
            ?: ask.menu?.question
            ?: Workers.detail(ask.worker)?.takeUnless(::generic)
            ?: "${ask.worker.name.ifBlank { "It" }} is waiting on an answer"

    private val GENERIC = Regex("""\bis asking the user\b|\basking (you|the user) \d+ question""", RegexOption.IGNORE_CASE)

    /** A notification line that only says a question was asked, not which. */
    fun generic(text: String): Boolean = GENERIC.containsMatchIn(text)

    private val ASK_TOOLS = setOf("AskUser", "AskUserQuestion", "request_user_input")
    private val QUESTION_LINE = Regex("""^\s*(?:\d+[.)]\s*)?\[question]\s*(.+)$""")
    private val OPTION_LINE = Regex("""^\s*\[option]\s*(.+)$""")
    private val MULTI = Regex("""\s*\(multi\)\s*$""", RegexOption.IGNORE_CASE)

    /** A question as its ask call wrote it, with the options it offered. */
    data class Asked(val question: String, val options: List<String>, val multiSelect: Boolean = false, val topic: String? = null)

    /**
     * The questions of the newest ask call still waiting on a result: Droid's `questionnaire`
     * ("1. [question] …" then "[option] …" lines) or a `questions` array of `{question, options}`.
     */
    fun questions(entries: List<ThreadEntry>): List<Asked> {
        val call = entries.lastOrNull { it.kind == ThreadKind.Tool && it.name in ASK_TOOLS } ?: return emptyList()
        if (call.output != null) return emptyList()
        val o = call.input?.trim()?.takeIf { it.startsWith("{") }
            ?.let { runCatching { OfficeJson.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: return emptyList()
        (o["questionnaire"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { text ->
            val out = ArrayList<Asked>()
            var question: String? = null
            val options = ArrayList<String>()
            var lastOption = false
            var continuingQuestion = false
            var multiSelect = false
            var topic: String? = null
            fun flush() {
                question?.let { out += Asked(it.trim(), options.map(String::trim), multiSelect, topic) }
                question = null
                options.clear()
                multiSelect = false
                topic = null
            }
            for (line in text.lines()) {
                QUESTION_LINE.matchEntire(line)?.let {
                    flush()
                    multiSelect = MULTI.containsMatchIn(it.groupValues[1])
                    question = it.groupValues[1].replace(MULTI, "").trim()
                    lastOption = false
                    continuingQuestion = true
                } ?: OPTION_LINE.matchEntire(line)?.let {
                    if (question != null) options += it.groupValues[1].trim()
                    lastOption = true
                } ?: run {
                    val trimmed = line.trimStart()
                    if (trimmed.startsWith("[topic]")) {
                        if (question != null) trimmed.removePrefix("[topic]").trim().takeIf { it.isNotEmpty() }?.let { topic = it }
                        lastOption = false
                        continuingQuestion = false
                    } else if (question != null) {
                        if (lastOption && options.isNotEmpty()) options[options.lastIndex] += "\n$line"
                        else if (continuingQuestion) {
                            if (MULTI.containsMatchIn(line)) multiSelect = true
                            question += "\n${line.replace(MULTI, "")}"
                        }
                    }
                }
            }
            flush()
            return out.filter { it.question.isNotEmpty() }
        }
        return (o["questions"] as? JsonArray).orEmpty().mapNotNull { q ->
            val qo = q as? JsonObject ?: return@mapNotNull null
            val text = (qo["question"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null } ?: return@mapNotNull null
            val options = (qo["options"] as? JsonArray).orEmpty().mapNotNull { opt ->
                when (opt) {
                    is JsonPrimitive -> opt.takeIf { it.isString }?.content
                    is JsonObject -> (opt["label"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    else -> null
                }?.trim()
            }
            val topic = listOf("header", "topic").firstNotNullOfOrNull { key -> (qo[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null } }
            Asked(text, options, (qo["multiSelect"] as? JsonPrimitive)?.booleanOrNull == true || (qo["multi_select"] as? JsonPrimitive)?.booleanOrNull == true, topic)
        }
    }

    /**
     * The open ask call's question whose ordered options and mode match [menu].
     * Ambiguous or mismatching questions never replace [menu]'s text.
     */
    fun asked(entries: List<ThreadEntry>, menu: Menu?): String? = matching(questions(entries), menu)?.question

    /**
     * The whole questionnaire being asked (src/shared/ask-question.ts pendingQuestions): [WorkerAsk]
     * has the structured questionnaire; the thread's open call is the fallback when none was sent.
     */
    fun pending(ask: WorkerAsk?, entries: List<ThreadEntry>): List<Asked> =
        ask?.takeIf { it.kind == "question" && it.questions.isNotEmpty() }?.questions
            ?.filter { it.question.isNotBlank() }?.map { Asked(it.question.trim(), it.options.map(String::trim), it.multiSelect, it.topic?.trim()?.ifEmpty { null }) }
            ?: questions(entries)

    enum class StepState { Done, Current, Upcoming }

    /** One step of a multi-question AskUser step bar. */
    data class Step(val label: String, val state: StepState, val answer: String? = null)

    private const val STEP_LABEL = 28
    private val TRAILING_WORD = Regex("""\s+\S*$""")
    private val WHITESPACE = Regex("""\s+""")

    private fun stepLabel(asked: Asked): String {
        asked.topic?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val first = asked.question.lineSequence().first().trim()
        if (first.length <= STEP_LABEL) return first
        val cut = first.take(STEP_LABEL - 1)
        return cut.replace(TRAILING_WORD, "").ifEmpty { cut } + "…"
    }

    /**
     * Where [menu] sits in its multi-question AskUser questionnaire (`1..N`, with no terminal review
     * step). Empty for a lone question or a menu matching no single question. [answers] is what this
     * app sent, by 1-based question position.
     */
    fun steps(menu: Menu, entries: List<ThreadEntry>, ask: WorkerAsk?, answers: Map<Int, String> = emptyMap()): List<Step> {
        val all = pending(ask, entries)
        if (all.size < 2) return emptyList()
        val at = matching(all, menu)?.let { all.indexOf(it) + 1 } ?: return emptyList()
        return all.mapIndexed { index, asked ->
            val state = when {
                index + 1 < at -> StepState.Done
                index + 1 == at -> StepState.Current
                else -> StepState.Upcoming
            }
            val answer = if (state == StepState.Done) answers[index + 1]?.ifEmpty { null } else null
            Step(stepLabel(asked), state, answer)
        }
    }

    /** One line for what a reply answered, in the question's own words (src/shared/ask-question.ts replySummary). */
    fun replySummary(display: Menu, choice: Int?, choices: List<Int>?, text: String?): String {
        fun label(number: Int) = display.choices.firstOrNull { it.number == number }?.label?.lineSequence()?.first()?.trim() ?: number.toString()
        val typed = text?.replace(WHITESPACE, " ")?.trim()?.ifEmpty { null }
        if (choices != null) return listOfNotNull(choices.joinToString(", ") { label(it) }.ifEmpty { null }, typed).joinToString(" + ")
        return typed ?: choice?.let(::label).orEmpty()
    }

    private fun norm(s: String) = s.lowercase().replace(WHITESPACE, " ").trim().trimEnd('…', '.')

    /** Match by numbered prefixes, never by an option appearing at a different number. */
    private fun matching(all: List<Asked>, menu: Menu?): Asked? {
        if (all.isEmpty()) return null
        if (menu == null) return all.singleOrNull()
        val candidates = all.filter { a ->
            a.multiSelect == menu.multiSelect && a.options.size == menu.choices.size && menu.choices.all { c ->
                val label = norm(c.label)
                val full = a.options.getOrNull(c.number - 1)?.let(::norm).orEmpty()
                label.isNotEmpty() && full.startsWith(label)
            }
        }
        if (candidates.size == 1) return candidates.single()
        // Several questions may use identical options. Only a unique matching question disambiguates.
        return candidates.filter { a ->
            val q = menu.question?.let(::norm) ?: return@filter false
            val full = norm(a.question)
            full == q || full.endsWith(q)
        }.singleOrNull()
    }

    /** Full pending-call metadata is for display only. Send the original menu in worker.answer, never this copy. */
    fun display(menu: Menu, entries: List<ThreadEntry>, ask: WorkerAsk? = null): Menu {
        val asked = matching(pending(ask, entries), menu) ?: return menu
        return menu.copy(
            question = asked.question,
            choices = menu.choices.map { c ->
                val full = asked.options.getOrNull(c.number - 1)?.trim() ?: c.label
                c.copy(label = full, description = c.description.takeIf { c.label == full })
            },
        )
    }

    /** A choice's label short enough for a notification button: "1 · Wait for drawer". */
    fun buttonLabel(choice: Choice, max: Int = 22): String {
        val label = if (choice.label.length <= max) choice.label else choice.label.take(max - 1).trimEnd() + "…"
        return "${choice.number} · $label"
    }
}
