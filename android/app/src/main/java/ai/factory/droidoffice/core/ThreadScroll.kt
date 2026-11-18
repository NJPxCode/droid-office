package ai.factory.droidoffice.core

/** Intent and index mapping for a reversed Thread list with a fixed tail at index zero. */
object ThreadScroll {
    /** [dy] is consumed physical movement, positive when a finger drags the conversation down to read earlier. */
    fun afterDrag(following: Boolean, dy: Float, away: Boolean): Boolean = !away || (following && dy <= 0f)

    fun showJump(following: Boolean, away: Boolean): Boolean = !following && away

    /** Seeing the head during first layout or in a short thread is not an instruction to fetch history. */
    fun autoPage(following: Boolean, searchScroll: Boolean, headVisible: Boolean): Boolean = !following && !searchScroll && headVisible

    fun indexOf(rowCount: Int, chronologicalIndex: Int): Int? =
        if (chronologicalIndex in 0 until rowCount) rowCount - chronologicalIndex else null
}
