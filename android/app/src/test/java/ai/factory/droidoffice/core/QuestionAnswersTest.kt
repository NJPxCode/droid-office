package ai.factory.droidoffice.core

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionAnswersTest {
    private val checkbox = Menu(
        question = "What does managing several agents simultaneously mean to you?",
        choices = listOf(
            Choice(1, "Persistent roster", description = "with live status while working in one conversation", selected = false),
            Choice(2, "Several conversations", description = "visible side by side", selected = true),
        ),
        pointer = null,
        freeText = true,
        multiSelect = true,
    )

    @Test
    fun togglingOnlyChangesTheLocalDesiredSet() {
        val first = QuestionAnswers.toggle(checkbox, listOf(2), 1)
        assertEquals(listOf(2, 1), first)
        assertEquals(listOf(1), QuestionAnswers.toggle(checkbox, first, 2))
        assertEquals(listOf(2), checkbox.choices.filter { it.selected == true }.map { it.number })
    }

    @Test
    fun singleSelectionIsNotAutomaticallySubmittedEither() {
        val single = checkbox.copy(multiSelect = false)
        assertEquals(listOf(1), QuestionAnswers.toggle(single, listOf(2), 1))
        assertEquals(listOf(2), QuestionAnswers.toggle(single, listOf(1), 2))
    }

    @Test
    fun sendCarriesTheFullDesiredSetAndStructuredMenuMetadata() {
        val wire = OfficeJson.parseToJsonElement(ClientMsg.workerAnswer("w", checkbox, "receipt", "floor", choices = listOf(1, 2))).jsonObject
        assertEquals("worker.answer", wire.getValue("t").jsonPrimitive.content)
        assertEquals("receipt", wire.getValue("requestId").jsonPrimitive.content)
        assertEquals("floor", wire.getValue("requestFloor").jsonPrimitive.content)
        assertEquals(listOf("1", "2"), wire.getValue("choices").jsonArray.map { it.jsonPrimitive.content })
        assertFalse(wire.containsKey("choice"))
        assertFalse(wire.containsKey("text"))
        assertEquals(checkbox, OfficeJson.decodeFromJsonElement(Menu.serializer(), wire.getValue("menu")))
        val receipt = Protocol.decode("""{"t":"action.result","requestId":"receipt","ok":false,"error":"Update the office"}""") as ServerMsg.ActionResult
        assertFalse(receipt.ok)
        assertEquals("Update the office", receipt.error)
    }

    @Test
    fun multiSelectionMayIncludeAnAdditionalTypedAnswerWithoutDroppingChecks() {
        assertTrue(QuestionAnswers.valid(checkbox, null, listOf(1, 2), "A third way"))
        assertFalse(QuestionAnswers.valid(checkbox, null, emptyList(), null))
        assertTrue(QuestionAnswers.valid(checkbox, null, emptyList(), "Only my own answer"))
        assertFalse(QuestionAnswers.valid(checkbox, 1, null, null))
        assertFalse(QuestionAnswers.valid(checkbox, null, listOf(1, 1), null))
        assertFalse(QuestionAnswers.valid(checkbox, null, listOf(3), null))
        assertFalse(QuestionAnswers.valid(checkbox.copy(multiSelect = false), null, listOf(1), null))
        val combined = OfficeJson.parseToJsonElement(ClientMsg.workerAnswer("w", checkbox, "id", "f", choices = listOf(2), text = "Also this")).jsonObject
        assertEquals("Also this", combined.getValue("text").jsonPrimitive.content)
        assertEquals("2", combined.getValue("choices").jsonArray.single().jsonPrimitive.content)
    }

    @Test
    fun takesTextRecognizesExplicitFreeTextAndOtherOptions() {
        val strict = Menu("Pick one", listOf(Choice(1, "Alpha"), Choice(2, "Beta")), freeText = false)
        assertFalse(Asks.takesText(strict))
        assertFalse(QuestionAnswers.valid(strict, null, null, "Custom"))
        assertTrue(Asks.takesText(strict.copy(freeText = true)))
        assertTrue(Asks.takesText(strict.copy(choices = strict.choices + Choice(3, "Other: specify"))))
        assertTrue(Asks.takesText(strict.copy(choices = strict.choices + Choice(3, "Type your own answer"))))
    }

    @Test
    fun onlyPointerAndCheckboxStateMayChangeWithoutInvalidatingTheMenu() {
        assertTrue(Asks.sameMenu(checkbox, checkbox.copy(pointer = 3, choices = checkbox.choices.map { it.copy(selected = it.selected != true) })))
        assertFalse(Asks.sameMenu(checkbox, checkbox.copy(multiSelect = false)))
        assertFalse(Asks.sameMenu(checkbox, checkbox.copy(freeText = false)))
        assertFalse(Asks.sameMenu(checkbox, checkbox.copy(choices = checkbox.choices.map { it.copy(description = "changed") })))
        assertFalse(Asks.sameMenu(checkbox, null))
    }
}
