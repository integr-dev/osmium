/**
 * Login mechanisms the operator can pick when setting a bot up.
 *
 * Placeholders until the real mechanisms are chosen. The `id` is relayed to the host verbatim and
 * the backend never interprets it, so replacing these is a change to this list plus the agent —
 * not to the protocol. See "`method` is a mechanism, never an account" in BOT_CONNECTIVITY.md.
 *
 * A method must never identify an account. "Use the device code flow" is a mechanism; an email
 * address or profile name would make the backend an authority on *which* identity to acquire.
 */
export interface LoginMethod {
  id: string
  label: string
  description: string
}

export const LOGIN_METHODS: LoginMethod[] = [
  { id: 'method_a', label: 'Method A', description: 'Placeholder mechanism, performed on the host.' },
  { id: 'method_b', label: 'Method B', description: 'Placeholder mechanism, performed on the host.' },
  { id: 'method_c', label: 'Method C', description: 'Placeholder mechanism, performed on the host.' },
  { id: 'method_d', label: 'Method D', description: 'Placeholder mechanism, performed on the host.' },
]
