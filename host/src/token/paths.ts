/**
 * Where this host keeps what it holds.
 *
 * Two locations rather than one, because two different things own them. The bindings are ours and
 * are read and written by both the router and `osmium-link`; the Microsoft token cache belongs to
 * prismarine-auth, which files an account under a name of its own choosing and rewrites it whenever
 * a token is refreshed.
 *
 * Both sit under the same volume, so a container that keeps `/agent` keeps its accounts.
 */

/** The bindings: which credential belongs to which agent. */
export function accountsPath(): string {
  return process.env['OSMIUM_ACCOUNTS'] ?? '/agent/accounts.json'
}

/** prismarine-auth's token cache. */
export function cachePath(): string {
  return process.env['OSMIUM_TOKEN_CACHE'] ?? '/agent/msa'
}
