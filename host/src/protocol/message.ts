import type { Component } from '../agent/chat.ts'
import type { Inventory } from '../agent/inventory.ts'
import type { MapTile } from '../agent/map.ts'
import type { LoginMethod } from '../token/login.ts'
import type { AdvertisedProxy } from '../agent/proxy.ts'
import type { ActivityScope, BlockPos, BuildState, ChatScope, LoginState, Player, Severity, Vec3 } from './wire.ts'

/** A command the backend sent. Only commands arrive; results and events travel the other way. */
export interface Command {
  /** Echoed back on the result that resolves it. */
  id: string
  agentId: number
  body: CommandBody
}

export type CommandBody =
  | {
      type: 'setup_agent'
      /** The operator's name for the agent, not a Minecraft one. Only ever logged on this side. */
      label: string
      /** The mechanism the operator picked, relayed verbatim from what we advertised.
       *
       * A string rather than a `LoginKind` because it is *our* id coming back to us: the backend
       * neither interprets nor stores it, so nothing guarantees it still names a kind this build
       * knows. `kindFromId` is where that is decided. */
      method: string
    }
  | { type: 'connect'; address: string }
  | { type: 'disconnect' }
  | { type: 'chat'; message: string }
  | { type: 'set_chat_listener'; enabled: boolean }
  /** Start or stop streaming this agent's world to whoever is watching it.
   *
   * Demand-driven, unlike everything else here. Following an agent means listening to every block
   * change and every entity movement in its view, so it runs only while somebody has a screen open
   * on it - the backend turns it off again when the last watcher goes away.
   *
   * Not remembered across a reconnect, and deliberately: a watcher that is still there re-asks, and
   * one that is not would otherwise leave the stream running for nobody. */
  | { type: 'set_viewer'; enabled: boolean }
  /** Configuration for this agent, as a flat map.
   *
   * **Whole, not a patch.** What arrives is everything the operator has set, so a key that is no
   * longer there has been cleared rather than left alone - which is the only reading that lets a
   * setting be turned back off.
   *
   * A key this build does not know is ignored. The list is declared by the interface, so a host
   * older than a setting is the ordinary case rather than an error. */
  | { type: 'settings'; values: Record<string, string> }
  /** Build this box. Fire and forget: answered with a `build_progress` event, never a result. */
  | {
      type: 'build_segment'
      jobId: number
      segmentId: number
      /** Minted by the act of sending this, and valid from the moment it arrives. */
      ticket: string
      min: BlockPos
      max: BlockPos
      blocks: number
    }
  /** Stop building that box. Not an error for one already finished or never started: it asks us to
   * stop, which having stopped satisfies. */
  | { type: 'cancel_segment'; jobId: number; segmentId: number }
  /** Move what is in one slot onto another, as a click on each would.
   *
   * Slot numbers are Minecraft's own, in the player window. Fire and forget: what came of it is
   * reported by the next `inventory` event, which is the same event that reports the agent
   * moving something itself. Refused for a slot outside the ones an operator may touch - see
   * `agent/inventory.ts`. */
  | { type: 'inventory_move'; from: number; to: number }
  /** Throw what is in a slot on the ground. An absent `count` means the whole stack. */
  | { type: 'inventory_drop'; slot: number; count?: number }
  /** Put a hotbar square in the agent's hand.
   *
   * The **window slot**, 36 to 44, not the 0-to-8 index the game keeps: every command here names a
   * square the same way, and the one index in this protocol is `held`, which is a field the game
   * itself defines as one. Refused for anything outside the hotbar. */
  | { type: 'inventory_hold'; slot: number }
  /** This agent is gone. Release everything held for it.
   *
   * Not an error for an agent this host has never heard of - it asks us to hold nothing for it,
   * which holding nothing already satisfies. Without it a host keeps a credential bound to an
   * agent that no longer exists, and no other message would ever say so. */
  | { type: 'delete_agent' }

/** The only command that is answered. Everything else reports its outcome as a state change. */
export type SetupResult =
  | { ok: true; mcUsername: string; mcUuid: string }
  /** `reason` is written for whoever reads host logs; the operator only sees the agent return to
   * `UNLINKED`. */
  | { ok: false; reason: string }

export interface Result {
  id: string
  agentId: number
  setup: SetupResult
}

/** One agent as this host currently has it, for the arrival announcement. */
export interface AgentSnapshot {
  agentId: number
  state: LoginState
}

/** The four readings the backend takes together or not at all.
 *
 * One value rather than four fields, because a tick carrying only some of them is dropped whole on
 * the other side - an absent `food` defaulting to zero renders as a starving agent. */
export interface Vitals {
  health: number
  food: number
  ping: number
  position: Vec3
}

export type Event =
  /** What this host is, sent once as the first frame after connecting.
   *
   * The only message that says what *exists*. Agent state is stored on the backend and outlives the
   * connection that reported it, so a host that restarts without this leaves Osmium asserting
   * sessions nobody is running. An empty `agents` is a real announcement - it says "I am running
   * none of them", which is what a freshly started host has to say. */
  | {
      type: 'handshake'
      agents: AgentSnapshot[]
      loginMethods: LoginMethod[]
      /** The proxies this host holds, by name. Addresses, never credentials - see `proxy.ts`. */
      proxies: AdvertisedProxy[]
    }
  | { type: 'heartbeat'; version: string }
  | {
      type: 'agent_status'
      agentId: number
      state?: LoginState
      dimension?: string
      nearby?: Player[]
      vitals?: Vitals
    }
  | {
      type: 'chat'
      agentId: number
      scope: ChatScope
      /** Absent means the label the backend already holds for this agent. */
      from?: string
      text: string
      /** The same line as a component tree, when the host could build one.
       *
       * Absent for anything a host said itself, and for a server that sent plain text. Whatever
       * draws chat falls back to {@link text}, which is always present and always the whole line. */
      components?: Component
      /** What the speaker typed, with the server's decoration taken off the front.
       *
       * Only this host can produce it: the `chat.sender` pattern that says where a prefix ends is
       * configuration this host holds, and the separator differs from server to server. Absent for
       * a line the pattern did not match, and for anything the agent said itself - the same cases
       * {@link from} cannot name a player for.
       *
       * Not stored anywhere. It exists so the backend can compare what people said without
       * comparing the rank prefix in front of it, which on a decorated server is most of a line. */
      typed?: string
    }
  | { type: 'activity'; agentId: number; scope: ActivityScope; severity: Severity; text: string }
  /** The agent decided to leave and asks not to be sent back — see `retreat` in `bot.ts`.
   *
   * Separate from going offline, which the backend already sees and reads as a drop worth undoing.
   * This says the absence is the point. */
  | { type: 'stand_down'; agentId: number; reason: string }
  /** What the agent is carrying, whenever it changes.
   *
   * Whole rather than per slot: an inventory is forty squares of a few bytes each, and a client
   * that assembled one out of deltas would have to be told when to throw its copy away - which is
   * every respawn, every dimension change and every reconnect. */
  | { type: 'inventory'; agentId: number; inventory: Inventory }
  /** One chunk of the world as it looks from above, for the map.
   *
   * Sent for the whole session rather than on demand, which is what makes the map worth opening:
   * it is already drawn by the time anybody does. Coordinates are the chunk's, not the block's.
   *
   * Carries block names and not colours - see `agent/map.ts`. The backend stores this verbatim and
   * holds no opinion about what any of it looks like. */
  | { type: 'map_tile'; agentId: number; tile: MapTile }
  /** How far through a segment we are. A total placed by *us* since being handed it, never a delta:
   * the backend reports the higher of this and what was standing when we took the piece. */
  | {
      type: 'build_progress'
      agentId: number
      segmentId: number
      blocksPlaced?: number
      state?: BuildState
      /** Why it failed. For whoever reads host logs; the operator never sees it. */
      reason?: string
    }

/** Anything this host sends. */
export type Outbound = { kind: 'result'; body: Result } | { kind: 'event'; body: Event }
