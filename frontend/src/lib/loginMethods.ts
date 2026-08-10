/**
 * Login mechanisms the operator can pick when setting an agent up.
 *
 * Placeholders until the real mechanisms are chosen. The id is relayed to the host verbatim and
 * the backend never interprets it, so replacing these is a change to this list plus the agent —
 * not to the protocol. See "`method` is a mechanism, never an account" in FLEET_CONNECTIVITY.md.
 *
 * A method must never identify an account. "Use the device code flow" is a mechanism; an email
 * address or profile name would make the backend an authority on *which* identity to acquire.
 *
 * Only the ids live here. Their wording is copy, and sits with the rest of it in `i18n/en.ts`
 * under `loginMethod.<id>`.
 */
export const LOGIN_METHOD_IDS = ['method_a', 'method_b', 'method_c', 'method_d'] as const

export type LoginMethodId = (typeof LOGIN_METHOD_IDS)[number]
