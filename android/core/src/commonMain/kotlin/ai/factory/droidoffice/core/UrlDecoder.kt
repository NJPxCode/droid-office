package ai.factory.droidoffice.core

/**
 * `java.net.URLDecoder.decode(s, UTF_8)` step for step: `+` is a space, each run of `%XY` escapes
 * is one UTF-8 byte sequence (malformed bytes become U+FFFD), and a short or non-hex escape throws
 * [IllegalArgumentException].
 */
internal object UrlDecoder {
    fun decode(s: String): String {
        val out = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            when (val c = s[i]) {
                '+' -> {
                    out.append(' ')
                    i++
                }
                '%' -> {
                    val bytes = ByteArray((s.length - i) / 3)
                    var pos = 0
                    var ch = c
                    while (i + 2 < s.length && ch == '%') {
                        // Like Integer.parseInt(s, i + 1, i + 3, 16), a sign is accepted, so "%-1" is negative.
                        val v = s.substring(i + 1, i + 3).toIntOrNull(16)
                            ?: throw IllegalArgumentException("URLDecoder: Illegal hex characters in escape (%) pattern")
                        if (v < 0) throw IllegalArgumentException("URLDecoder: Illegal hex characters in escape (%) pattern - negative value")
                        bytes[pos++] = v.toByte()
                        i += 3
                        if (i < s.length) ch = s[i]
                    }
                    if (i < s.length && ch == '%') throw IllegalArgumentException("URLDecoder: Incomplete trailing escape (%) pattern")
                    out.append(bytes.decodeToString(0, pos))
                }
                else -> {
                    out.append(c)
                    i++
                }
            }
        }
        return out.toString()
    }
}
