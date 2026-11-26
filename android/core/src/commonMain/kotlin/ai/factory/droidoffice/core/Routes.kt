package ai.factory.droidoffice.core

/** How the phone reaches an office on a base URL. Lower [rank] is preferred when several answer. */
enum class RouteKind(val rank: Int, val label: String) {
    Lan(0, "Wi-Fi"),
    Tailscale(1, "Tailscale"),
    Remote(2, "Internet"),
}

object Routes {
    fun host(base: String): String = base.substringAfter("://").substringBefore('/').let { hostPort ->
        if (hostPort.startsWith("[")) hostPort.substringBefore(']').removePrefix("[") else hostPort.substringBefore(':')
    }

    /**
     * The routes worth trying while connected on [current]: the ones of a better kind (Wi-Fi while
     * on Tailscale), so the phone moves back to the local network once it answers again.
     */
    fun better(bases: List<String>, current: String): List<String> {
        val rank = kindOf(current).rank
        return bases.distinct().filter { it != current && kindOf(it).rank < rank }
    }

    fun kindOf(base: String): RouteKind {
        val host = host(base).lowercase()
        if (isTailscaleHost(host)) return RouteKind.Tailscale
        val v4 = parseIpv4(host)
        if (v4 != null) return if (isPrivateV4(v4)) RouteKind.Lan else RouteKind.Remote
        if (host.contains(':')) {
            val v6 = parseIpv6(host)
            return if (v6 != null && isPrivate(v6)) RouteKind.Lan else RouteKind.Remote
        }
        return if (isLocalName(host)) RouteKind.Lan else RouteKind.Remote
    }

    /** MagicDNS names, the 100.64.0.0/10 range Tailscale hands out, and its fd7a:115c:a1e0::/48 IPv6 range. */
    fun isTailscaleHost(host: String): Boolean {
        val h = host.lowercase().trimEnd('.')
        if (h.endsWith(".ts.net")) return true
        parseIpv4(h)?.let { return isCgnat(it) }
        if (h.startsWith("fd7a:115c:a1e0:")) return true
        return false
    }

    /** Bare names (`my-mac`) and mDNS / home-network suffixes resolve on the local network. */
    fun isLocalName(host: String): Boolean {
        val h = host.lowercase().trimEnd('.')
        if (h == "localhost") return true
        if (!h.contains('.')) return true
        return h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".internal")
    }

    /**
     * Whether cleartext HTTP may go to this address: loopback, link-local, RFC 1918, Tailscale's
     * CGNAT range and IPv6 unique-local. Anything on the public internet needs HTTPS.
     */
    fun isPrivate(address: ByteArray): Boolean = when (address.size) {
        4 -> isPrivateV4(address)
        16 -> isPrivateV6(address)
        else -> false
    }

    /**
     * IPv6 loopback (::1), link-local (fe80::/10) and site-local (fec0::/10), which together are
     * fe80::/9, unique-local (fc00::/7), and an IPv4-mapped address by its IPv4 part.
     */
    private fun isPrivateV6(b: ByteArray): Boolean {
        if (isV4Mapped(b)) return isPrivateV4(b.copyOfRange(12, 16))
        val a0 = b[0].toInt() and 0xff
        val a1 = b[1].toInt() and 0xff
        val loopback = (0 until 15).all { b[it].toInt() == 0 } && b[15].toInt() == 1
        return loopback || (a0 == 0xfe && a1 >= 0x80) || (a0 and 0xfe) == 0xfc
    }

    /** ::ffff:a.b.c.d */
    private fun isV4Mapped(b: ByteArray): Boolean = (0 until 10).all { b[it].toInt() == 0 } && b[10].toInt() == -1 && b[11].toInt() == -1

    fun isPrivateV4(b: ByteArray): Boolean {
        val a0 = b[0].toInt() and 0xff
        val a1 = b[1].toInt() and 0xff
        return a0 == 10 || a0 == 127 || (a0 == 172 && a1 in 16..31) || (a0 == 192 && a1 == 168) || (a0 == 169 && a1 == 254) || isCgnat(b)
    }

    private fun isCgnat(b: ByteArray): Boolean {
        val a0 = b[0].toInt() and 0xff
        val a1 = b[1].toInt() and 0xff
        return a0 == 100 && a1 in 64..127
    }

    /**
     * An IPv6 literal (`::1`, `fe80::1%wlan0`, `::ffff:192.168.1.2`) as 16 bytes, without touching DNS;
     * null for anything else. An IPv4-mapped address comes back as its 4 IPv4 bytes, as Java's
     * `InetAddress` gives it.
     */
    fun parseIpv6(host: String): ByteArray? {
        var text = host.substringBefore('%')
        // A trailing dotted quad stands for the last two groups; read it on its own.
        val last = text.substringAfterLast(':', "")
        val v4Tail = if ('.' in last) parseIpv4(last) ?: return null else null
        if (v4Tail != null) text = text.dropLast(last.length) + "0:0"
        val halves = text.split("::")
        if (halves.size > 2) return null
        val left = hexGroups(halves[0]) ?: return null
        val right = if (halves.size == 2) hexGroups(halves[1]) ?: return null else emptyList()
        val zeros = 8 - left.size - right.size
        // "::" stands for at least one group of zeros; without it the groups must fill all eight.
        val fits = if (halves.size == 2) zeros >= 1 else zeros == 0
        if (!fits) return null
        val out = ByteArray(16)
        for ((i, g) in (left + List(zeros) { 0 } + right).withIndex()) {
            out[2 * i] = (g ushr 8).toByte()
            out[2 * i + 1] = g.toByte()
        }
        v4Tail?.copyInto(out, 12)
        return if (isV4Mapped(out)) out.copyOfRange(12, 16) else out
    }

    /** Colon-separated groups of one to four hex digits; empty for an empty [part], null if any is malformed. */
    private fun hexGroups(part: String): List<Int>? {
        if (part.isEmpty()) return emptyList()
        return part.split(':').map { g ->
            if (g.isEmpty() || g.length > 4 || !g.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
            g.toInt(16)
        }
    }

    /** A dotted-quad IPv4 literal, without touching DNS; null for anything else. */
    fun parseIpv4(host: String): ByteArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val out = ByteArray(4)
        for ((i, p) in parts.withIndex()) {
            if (p.isEmpty() || p.length > 3 || !p.all(Char::isDigit)) return null
            val n = p.toInt()
            if (n > 255) return null
            out[i] = n.toByte()
        }
        return out
    }
}
