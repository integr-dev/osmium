/**
 * The values that cross the socket, and nothing else.
 *
 * Two projects own the two halves of every table in here, so each one is written out rather than
 * derived from a name on this side. A spelling that is merely convenient in TypeScript is a state
 * the backend logs as unknown and drops.
 */

/** The backend's `AgentState`, for the states a host is allowed to assert about itself.
 *
 * `SETUP_PENDING`, `CONNECTING` and `STALE` have no counterpart on purpose: the first two describe
 * a command the backend is waiting on, and the third is derived from whether this host is talking
 * at all. A host cannot report any of the three about itself. */
export const LoginState = {
  Online: 'ONLINE',
  FailedConnection: 'CONNECT_FAILED',
  UnlinkedCredentials: 'UNLINKED',
  LinkedCredentials: 'LINKED',
  NeedLinkCredentials: 'NEEDS_RELINK',
} as const

export type LoginState = (typeof LoginState)[keyof typeof LoginState]

/** Classified here because only this side sees the raw packet types. A scope the backend does not
 * recognise is dropped rather than guessed at, so these strings are exact. */
export const ChatScope = {
  Global: 'global',
  Direct: 'direct',
  Outbound: 'outbound',
} as const

export type ChatScope = (typeof ChatScope)[keyof typeof ChatScope]

/** How a segment is going. `building` while it is, then exactly one of the other two. */
export const BuildState = {
  Building: 'building',
  Done: 'done',
  Failed: 'failed',
} as const

export type BuildState = (typeof BuildState)[keyof typeof BuildState]

/** `system` when the server acted on the agent, `lifecycle` when the session changed. */
export const ActivityScope = { System: 'system', Lifecycle: 'lifecycle' } as const
export type ActivityScope = (typeof ActivityScope)[keyof typeof ActivityScope]

export const Severity = { Info: 'info', Warning: 'warning', Error: 'error' } as const
export type Severity = (typeof Severity)[keyof typeof Severity]

/** A point an entity stands at. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A block coordinate, as the corners of a build segment are given.
 *
 * Whole numbers, unlike {@link Vec3}: these name blocks in the world rather than the continuous
 * point an entity stands at, and rounding one into the other loses the distinction on a boundary. */
export interface BlockPos {
  x: number
  y: number
  z: number
}

export interface Player {
  name: string
  distance: number
  position: Vec3
}
