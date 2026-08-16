package net.integr.osmium.hostlink

/**
 * A login mechanism a host says it can perform, taken from its handshake.
 *
 * **The host is the authority on this list and the backend does not interpret it.** [id] is an
 * opaque string relayed back verbatim in `setup_agent`; the backend only ever compares it to the
 * list the same host advertised, which is membership rather than meaning. It never learns what a
 * method *does*, which is the coupling the whole credential design exists to avoid.
 *
 * [label] and [description] are copy for the operator choosing between mechanisms. They describe
 * the mechanism and nothing else: the rule that a method is never an account applies here exactly
 * as it does to the field it names. A host advertising "Sign in as build-bot-4@example.com" would
 * be handing the backend an identity to be an authority on, and the point of the list is that it
 * does the opposite — it says what this machine can do, not who it should become.
 *
 * Not stored. Like a host's reachability, this is a claim about a process that is running right
 * now; a row asserting methods a restarted host no longer offers would be worse than no row.
 */
data class LoginMethod(
    val id: String,
    val label: String? = null,
    val description: String? = null,
)
