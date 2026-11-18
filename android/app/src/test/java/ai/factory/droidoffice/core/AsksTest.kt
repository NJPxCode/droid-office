package ai.factory.droidoffice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AsksTest {
    private val greetingMenu = Menu(
        question = "Which greeting should I write into HELLO.md?",
        choices = listOf(Choice(1, "hi"), Choice(2, "hello")),
        freeText = true,
    )

    private val noQuestionMenu = Menu(
        question = null,
        choices = listOf(Choice(1, "Short"), Choice(2, "Long")),
        freeText = true,
    )

    @Test
    fun theQueueIsWhoeverWaitedLongestFirstAndExcludesShells() {
        val a = WorkerInfo(id = "a", name = "Ada", status = "needs_input", waitingSince = 200)
        val b = WorkerInfo(id = "b", name = "Byte", status = "needs_input", waitingSince = 100, menu = greetingMenu)
        val c = WorkerInfo(id = "c", name = "Cy", status = "working")
        val shell = WorkerInfo(id = "s", kind = "shell", name = "Shell", status = "needs_input", waitingSince = 50, menu = greetingMenu)
        val q = Asks.queue(listOf(a, b, c, shell))
        assertEquals(listOf("b", "a"), q.map { it.worker.id })
        assertEquals("Which greeting should I write into HELLO.md?", q[0].menu?.question)
        assertNull(q[1].menu)
    }

    @Test
    fun structuredMenuWorksForLocalAgentsOrchestratorAndCloudButNeverShells() {
        val local = WorkerInfo(id = "w1", kind = "agent", status = "needs_input", menu = greetingMenu)
        val orchestrator = WorkerInfo(id = ORCHESTRATOR_ID, kind = "agent", status = "needs_input", menu = greetingMenu)
        val cloud = WorkerInfo(id = "c1", kind = "cloud", status = "needs_input", cloud = CloudRef(computerId = "comp-1", menu = greetingMenu))
        val shell = WorkerInfo(id = "s1", kind = "shell", status = "needs_input", menu = greetingMenu)

        assertEquals(greetingMenu, Asks.menu(local))
        assertEquals(greetingMenu, Asks.menu(orchestrator))
        assertEquals(greetingMenu, Asks.menu(cloud))
        assertNull(Asks.menu(shell))

        assertTrue(Asks.canAnswer(local))
        assertTrue(Asks.canAnswer(orchestrator))
        assertTrue(Asks.canAnswer(cloud))
        assertFalse(Asks.canAnswer(shell))
        assertFalse(Asks.canAnswer(local.copy(menu = null)))
        assertFalse(Asks.canAnswer(cloud.copy(cloud = cloud.cloud!!.copy(menu = null))))
    }

    @Test
    fun aMenuDoesNotMakeANonWaitingWorkerAnswerable() {
        val w = WorkerInfo(id = "a", menu = greetingMenu)
        WorkerStatus.entries.filter { it != WorkerStatus.NeedsInput }.forEach {
            assertFalse(it.name, Asks.canAnswer(w.copy(status = it.wire)))
        }
    }

    @Test
    fun aCloudWorkersHeldAskUserDecodesAndDisplaysDescriptions() {
        val w = OfficeJson.decodeFromString(
            WorkerInfo.serializer(),
            """{"id":"133e8da1eaa0","kind":"cloud","name":"Pixel","status":"needs_input",
              "ask":{"kind":"question","questions":[{"question":"How should a multi-question series flow inside the single overlay?","topic":"Series flow","options":["Guided stepper (Recommended)","Fill all, then send"],"multiSelect":false}]},
              "cloud":{"computerId":"d284b509","computerName":"mac-mini","autonomy":"high","menu":{"question":"How should a multi-question series flow inside the single overlay?",
                "choices":[{"number":1,"label":"Guided stepper (Recommended)","description":"One overlay for the whole AskUser call."},{"number":2,"label":"Fill all, then send"}],"freeText":true}}}""",
        )
        val menu = Asks.menu(w)!!
        assertEquals(listOf("Guided stepper (Recommended)", "Fill all, then send"), menu.choices.map { it.label })
        assertNull(menu.pointer)
        assertTrue(Asks.canAnswer(w))
        assertEquals("How should a multi-question series flow inside the single overlay?", Asks.question(PendingAsk(w, menu)))
        assertEquals("One overlay for the whole AskUser call.", Asks.display(menu, emptyList(), w.ask).choices[0].description)
    }

    @Test
    fun theQuestionFallsBackToWhatTheOfficeSaysAndSkipsGenericNotices() {
        val w = WorkerInfo(id = "a", name = "Ada", status = "needs_input", activity = "Waiting on schema choice")
        assertEquals("Waiting on schema choice", Asks.question(PendingAsk(w, null)))
        assertEquals("Ada is waiting on an answer", Asks.question(PendingAsk(w.copy(activity = null), null)))
        assertEquals(
            "Ada is waiting on an answer",
            Asks.question(PendingAsk(w.copy(activity = "Factory CLI is asking the user 1 question(s)"), null)),
        )
        assertTrue(Asks.generic("Factory CLI is asking the user 3 question(s)"))
        assertFalse(Asks.generic("Which size should the summary use"))
    }

    private fun askCall(input: String, output: String? = null) =
        ThreadEntry(id = "t1", seq = 5, role = ThreadRole.Assistant, kind = ThreadKind.Tool, name = "AskUser", input = input, output = output)

    @Test
    fun openAskCallEnrichesMenuQuestionUntilAnswered() {
        val w = WorkerInfo(id = "a", name = "Ada", status = "needs_input", activity = "Factory CLI is asking the user 1 question(s)")
        val call = askCall("""{"questionnaire":"1. [question] Which size should the summary use\n\n[topic] Size\n[option] Short\n[option] Long"}""")
        assertEquals("Which size should the summary use", Asks.question(PendingAsk(w, noQuestionMenu), listOf(call)))
        assertEquals("Ada is waiting on an answer", Asks.question(PendingAsk(w, noQuestionMenu), listOf(call.copy(output = "Short"))))
    }

    @Test
    fun ofSeveralQuestionsTheOneWhoseOptionsMatchMenuIsShown() {
        val call = askCall(
            """{"questionnaire":"1. [question] Which colour?\n[topic] Colour\n[option] Orange\n[option] Blue\n\n2. [question] Which size should the summary use\n[topic] Size\n[option] Short: a line\n[option] Long: a page"}""",
        )
        assertEquals("Which size should the summary use", Asks.asked(listOf(call), noQuestionMenu))
        val other = Menu(null, listOf(Choice(1, "Yes"), Choice(2, "No")), null)
        assertNull(Asks.asked(listOf(call), other))
    }

    @Test
    fun aQuestionsArrayReadsTheSame() {
        val call = askCall("""{"questions":[{"question":"Ship it now","options":[{"label":"Short"},{"label":"Long"}]}]}""").copy(name = "AskUserQuestion")
        assertEquals("Ship it now", Asks.asked(listOf(call), noQuestionMenu))
        assertNull(Asks.asked(listOf(call.copy(input = "not json")), null))
    }

    @Test
    fun fullPendingMetadataWinsOverTruncatedTextOnlyForDisplay() {
        val question = "Before choosing, consider the whole workflow.\n\n" + "Important context. ".repeat(30) + "Which design should we use?"
        val full = listOf("Persistent roster: " + "complete option text ".repeat(30), "Several conversations: " + "all of the details ".repeat(30))
        val call = askCall(OfficeJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), kotlinx.serialization.json.buildJsonObject {
            put("questionnaire", kotlinx.serialization.json.JsonPrimitive("1. [question] $question (multi)\n[topic] Workflow\n[option] ${full[0]}\n[option] ${full[1]}"))
        }))
        val menu = Menu("Which design should we use?", listOf(Choice(1, "Persistent roster", selected = false), Choice(2, "Several conversations", selected = true)), null, true, true)
        val display = Asks.display(menu, listOf(call))
        assertEquals(question, display.question)
        assertEquals(full.map(String::trim), display.choices.map { it.label })
        assertEquals("Persistent roster", menu.choices[0].label)
        assertEquals(listOf(false, true), display.choices.map { it.selected })
    }

    @Test
    fun identicalOptionsAcrossQuestionsAreAmbiguousAndSwappedNumbersNeverMatch() {
        val call = askCall("""{"questionnaire":"1. [question] Colour?\n[option] Yes\n[option] No\n2. [question] Size?\n[option] Yes\n[option] No"}""")
        val menu = Menu(null, listOf(Choice(1, "Yes"), Choice(2, "No")), null)
        assertNull(Asks.asked(listOf(call), menu))
        assertEquals("Size?", Asks.asked(listOf(call), menu.copy(question = "Size?")))
        assertNull(Asks.asked(listOf(call), menu.copy(choices = listOf(Choice(1, "No"), Choice(2, "Yes")))))
        assertNull(Asks.asked(listOf(call), menu.copy(choices = listOf(Choice(1, "Yes, a different option"), Choice(2, "No")))))
        assertNull(Asks.asked(listOf(call), menu.copy(multiSelect = true)))
    }

    @Test
    fun multilineMetadataPreservesParagraphsAndModesWithoutTopicDetails() {
        val call = askCall("""{"questionnaire":"1. [question] Context before the question.\n\nWhich design? (multi)\n[topic] Design\nIgnored topic detail\n[option] Persistent roster\nwith live status\n[option] Several conversations\nside by side"}""")
        assertEquals(listOf(Asks.Asked("Context before the question.\n\nWhich design?", listOf("Persistent roster\nwith live status", "Several conversations\nside by side"), true, "Design")), Asks.questions(listOf(call)))
    }

    @Test
    fun structuredWorkerAskWinsOverThreadFallback() {
        val hook = WorkerAsk(kind = "question", questions = listOf(AskedQuestion("Which size should the summary use for the release notes?", "Size", listOf("Short: one line", "Long: a page"))))
        val w = WorkerInfo(id = "a", name = "Ada", status = "needs_input", ask = hook)
        assertEquals("Which size should the summary use for the release notes?", Asks.question(PendingAsk(w, noQuestionMenu)))
        assertEquals(listOf("Short: one line", "Long: a page"), Asks.display(noQuestionMenu, emptyList(), hook).choices.map { it.label })
        val other = hook.copy(questions = listOf(AskedQuestion("Colour?", options = listOf("Red", "Blue", "Green"))))
        assertEquals(noQuestionMenu, Asks.display(noQuestionMenu, emptyList(), other))
    }

    @Test
    fun contextAndButtonLabelFormatting() {
        assertEquals("Fix the flaky test", Asks.context(WorkerInfo(id = "a", prompt = "\nFix the flaky test\nand more")))
        assertEquals("Checkout", Asks.context(WorkerInfo(id = "a", title = "Checkout", prompt = "x")))
        assertNull(Asks.context(WorkerInfo(id = "a")))
        assertEquals("1 · Wait for the cart dra…", Asks.buttonLabel(Choice(1, "Wait for the cart drawer to open")))
    }

    @Test
    fun multiQuestionAskUserBuildsQuestionStepsWithoutTerminalReviewStep() {
        val ask = WorkerAsk(
            kind = "question",
            questions = listOf(
                AskedQuestion("Which hypervisor should we use?", "Hypervisor", listOf("UTM", "Parallels")),
                AskedQuestion("Which Windows licence features should the virtual machines have for agents?", null, listOf("Evaluation", "Pro", "Enterprise"), multiSelect = true),
                AskedQuestion("How should agents connect?", "Agent-access", listOf("SSH", "RDP")),
            ),
        )
        val first = Menu(
            question = "Which hypervisor should we use?",
            choices = listOf(Choice(1, "UTM"), Choice(2, "Parallels")),
            freeText = true,
        )
        val second = Menu(
            question = "Which Windows licence features should the virtual machines have for agents?",
            choices = listOf(Choice(1, "Evaluation", selected = false), Choice(2, "Pro", selected = true), Choice(3, "Enterprise", selected = false)),
            freeText = true,
            multiSelect = true,
        )
        assertEquals(
            listOf(
                Asks.Step("Hypervisor", Asks.StepState.Done, "Parallels"),
                Asks.Step("Which Windows licence…", Asks.StepState.Current),
                Asks.Step("Agent-access", Asks.StepState.Upcoming),
            ),
            Asks.steps(second, emptyList(), ask, mapOf(1 to "Parallels", 2 to "Stale")),
        )
        val display = Asks.display(second, emptyList(), ask)
        assertEquals("Evaluation, Enterprise + Keep shortcuts handy", Asks.replySummary(display, null, listOf(1, 3), "Keep  shortcuts\nhandy"))
        assertEquals("Pro", Asks.replySummary(display, null, listOf(2), null))
        assertEquals("Parallels", Asks.replySummary(Asks.display(first, emptyList(), ask), 2, null, null))
        assertEquals("Hyper-V", Asks.replySummary(Asks.display(first, emptyList(), ask), null, null, "Hyper-V"))

        // A lone question or non-matching menu produces no step bar.
        assertEquals(emptyList<Asks.Step>(), Asks.steps(first, emptyList(), ask.copy(questions = ask.questions.take(1))))
        assertEquals(emptyList<Asks.Step>(), Asks.steps(noQuestionMenu, emptyList(), ask))
    }

    @Test
    fun askUserHeadersAreTopicsAndTheThreadStandsInForAMissingHookAsk() {
        val call = askCall("""{"questions":[{"question":"Which hypervisor?","header":" Hypervisor ","options":[{"label":"UTM"},{"label":"Parallels"}]},{"question":"Licence?","options":["Evaluation"]}]}""")
        assertEquals(
            listOf(Asks.Asked("Which hypervisor?", listOf("UTM", "Parallels"), topic = "Hypervisor"), Asks.Asked("Licence?", listOf("Evaluation"))),
            Asks.pending(null, listOf(call)),
        )
        val hook = WorkerAsk(kind = "question", questions = listOf(AskedQuestion("From the hook?", "Hook", listOf("Yes", "No"))))
        assertEquals(listOf(Asks.Asked("From the hook?", listOf("Yes", "No"), topic = "Hook")), Asks.pending(hook, listOf(call)))
        assertEquals(2, Asks.pending(WorkerAsk(kind = "question"), listOf(call)).size)
    }
}
