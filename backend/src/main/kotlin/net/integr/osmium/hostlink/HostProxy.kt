package net.integr.osmium.hostlink

/**
 * A proxy a host says it can route an agent's session through, taken from its handshake.
 *
 * **Named here, held there.** The whole of what crosses this boundary is a name, an address and
 * whether the proxy wants a password — never the password itself, and never the username. Those sit
 * in a file on the host beside the account store, for the same reason a Minecraft credential does:
 * a value the backend holds is a value that is stored in Postgres, rendered into a form and sent
 * back down a socket, and a proxy credential has no business in any of the three.
 *
 * What an operator sets on an agent is `connect.proxy`, holding one of these [name]s. The backend
 * relays that string without interpreting it, exactly as it relays a login `method`; the host is
 * the only thing that ever turns it into somewhere to dial.
 *
 * [host] and [port] are here because an operator choosing between four proxies is choosing between
 * four places, and a list that will not say where they are is a list of four indistinguishable
 * words. They are also what lets the fleet graph draw the route an agent actually takes.
 *
 * Not stored, like [LoginMethod] and for the same reason: it is a claim about a process running now.
 */
data class HostProxy(
    val name: String,
    /** `socks5`, `socks4`, `http` or `https` — the host's word for it, uninterpreted here. */
    val kind: String,
    val host: String,
    val port: Int,
    /** Whether it wants a credential. Said, never shown: the credential stays on the host. */
    val authenticated: Boolean,
)
