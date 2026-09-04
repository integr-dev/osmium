import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { log, reason } from '../log.ts'
import { lock, writeAtomically } from './files.ts'
import { LoginKind, type StoredKind } from './login.ts'

/**
 * One credential, and the agent it belongs to once one has been set up with it.
 *
 * **The binding lives here, with the credential.** Nothing else in the system records which account
 * is whose: the backend relays a mechanism and never an identity, and the handshake only travels
 * host to backend.
 *
 * **The Microsoft secrets are not in here.** prismarine-auth owns its own token cache, and `cache`
 * is the key it files an account under - so this store holds a name for a credential rather than
 * the credential itself. A session token has nowhere else to live and so is kept here in full.
 */
export interface Entry {
  /** Stable for the life of the credential, across rewrites and across processes. */
  id: string
  kind: StoredKind
  /** The agent this belongs to, once one has been set up with it. */
  agent?: number
  /** `refresh_token`: what prismarine-auth files this account's tokens under. */
  cache?: string
  /** `mojang_token`: the session token itself. Nothing in Osmium can obtain one, so there is
   * nowhere else for it to be. */
  token?: string
  /** The Minecraft name. For `no_token` it *is* the identity - kept so that a restored offline
   * agent rejoins under the name it had rather than a new one every restart. */
  username?: string
  /** The Minecraft uuid, once anything has looked it up. */
  uuid?: string
}

/** What a credential is, without the credential. */
export interface Summary {
  id: string
  kind: StoredKind
  agent: number | undefined
  username: string | undefined
}

/**
 * The credentials this host can play, and which agent each belongs to.
 *
 * **Several processes may hold this file at once.** The router runs continuously while
 * `osmium-link` is run by hand to add accounts, so every write is a locked read-modify-write
 * against what is on disk *now* rather than a dump of what this process last saw. Writing from
 * memory silently drops whatever the other had added since.
 *
 * There is no separate record of which credential is *in use*. The binding is the exclusion: an
 * account belonging to agent 5 is never handed to agent 6, whether or not agent 5 is running.
 */
export class AccountStore {
  private entries: Entry[] = []
  /** In-process serialisation. Node runs one thing at a time, but an `await` inside a
   * read-modify-write is a point where another one can start - so they queue behind each other here
   * as well as behind the file lock. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(readonly path: string) {}

  /**
   * Reads the store, treating a missing file as an empty one.
   *
   * A host with no credentials at all is an ordinary starting state: device code puts the first one
   * there, through the interface, without anybody logging in to the machine. A file that exists but
   * cannot be parsed is still fatal - starting empty would quietly ignore credentials somebody is
   * relying on, and the next write would overwrite them.
   */
  static async open(path: string): Promise<AccountStore> {
    const store = new AccountStore(path)
    store.entries = await load(path)
    return store
  }

  /** Every agent this host holds a credential for, for rebuilding them on start.
   *
   * Without it a restarted host announces that it runs nothing, the backend reports its agents as
   * LINKED - "the host holds credentials for this agent", which is true - and yet `connect` reaches
   * a host that has no such agent. */
  boundAgents(): number[] {
    const agents = new Set<number>()
    for (const entry of this.entries) if (entry.agent !== undefined) agents.add(entry.agent)
    return [...agents].sort((a, b) => a - b)
  }

  /** What is in the store, without any of the secrets. */
  summary(): Summary[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      agent: entry.agent,
      username: entry.username,
    }))
  }

  /** The credential already bound to an agent, for rebuilding it after a restart.
   *
   * Changes nothing on disk - the binding is already there, which is the whole point. */
  restore(agent: number): Entry | undefined {
    return this.entries.find((entry) => entry.agent === agent)
  }

  /**
   * Takes a credential of the given kind for an agent, and records that it is theirs.
   *
   * One already bound to this agent is preferred, so setting the same agent up twice does not
   * consume a second account. Otherwise any free, unbound one of that kind will do.
   *
   * **Exclusion is global, not per server.** Setting an agent up is acquiring a credential, and
   * where it plays arrives later with `connect` and can change afterwards - so there is no network
   * to key on at the moment one is handed out. An account is one identity: one agent.
   */
  async claim(kind: StoredKind, agent: number): Promise<Entry | undefined> {
    // An offline login is not a credential - it is a name this host makes up - so agents do not
    // compete for one. Each gets an entry of its own, which is also what lets an offline agent be
    // rebuilt after a restart like any other.
    if (kind === LoginKind.NoToken) {
      return this.adopt({ kind, username: offlineName() }, agent)
    }

    return this.mutate((entries) => {
      const mine = entries.find((entry) => entry.kind === kind && entry.agent === agent)
      const entry = mine ?? entries.find((one) => one.kind === kind && one.agent === undefined)

      if (!entry) return undefined

      entry.agent = agent
      return entry
    })
  }

  /**
   * Keeps a credential, optionally bound to the agent that acquired it.
   *
   * `agent` is left out when one is loaded into the pool with nothing to bind it to - `osmium-link`
   * does that, before any agent exists to own it.
   *
   * Written to disk before it is returned. An operator who has approved a sign-in has done the one
   * part of this nobody can repeat for them, so losing it to a restart moments later is the failure
   * worth spending a write to avoid.
   */
  async adopt(fresh: Omit<Entry, 'id' | 'agent'>, agent?: number): Promise<Entry> {
    return this.mutate((entries) => {
      // Signing in twice as the same account is the operator's business; keeping two copies of the
      // credential is not, because the second could be bound to a second agent - the
      // one-account-one-agent rule this store exists to hold. Matched on the Minecraft identity
      // rather than on the secret, because two sign-ins to one account leave two different secrets.
      const existing =
        fresh.uuid === undefined
          ? undefined
          : entries.find(
              (entry) => entry.kind === fresh.kind && entry.uuid === fresh.uuid && entry.agent === undefined,
            )

      if (existing) {
        Object.assign(existing, fresh)
        if (agent !== undefined) existing.agent = agent
        return existing
      }

      const entry: Entry = { id: randomUUID(), ...fresh }
      if (agent !== undefined) entry.agent = agent

      entries.push(entry)
      return entry
    })
  }

  /** Records what an account turned out to be, so `osmium-link list` can name it.
   *
   * Best effort: an identity that could not be written down is worth less than the log line saying
   * so, and never worth failing a working login over. */
  async describe(id: string, username: string, uuid: string): Promise<void> {
    try {
      await this.mutate((entries) => {
        const entry = entries.find((one) => one.id === id)
        if (entry) Object.assign(entry, { username, uuid })
      })
    } catch (err) {
      log.warn(`Could not record who ${id} is: ${reason(err)}`)
    }
  }

  /**
   * Forgets an agent, and everything held for it.
   *
   * The credential itself is kept and returned to the pool: it is an account, and the agent being
   * gone says nothing about whether the operator still wants to play it. An offline login is the
   * exception - a generated name rather than an account, so its entry goes with the agent that
   * generated it rather than accumulating one per deleted agent forever.
   */
  async release(agent: number): Promise<void> {
    await this.mutate((entries) => {
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!
        if (entry.agent !== agent) continue

        if (entry.kind === LoginKind.NoToken) entries.splice(index, 1)
        else delete entry.agent
      }
    })
  }

  /** Drops one credential entirely. `false` when there was nothing by that id. */
  async remove(id: string): Promise<boolean> {
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) return false

      entries.splice(index, 1)
      return true
    })
  }

  /**
   * Applies a change to the file itself, then refreshes this process from the result.
   *
   * The queue is taken first and the file lock second, always in that order, so two of these cannot
   * deadlock against each other.
   */
  private async mutate<T>(change: (entries: Entry[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await lock(this.path)

      try {
        // What is on disk now, not what we last saw: another process may have added an account
        // since, and writing our own copy back is exactly how that gets lost.
        const entries = await load(this.path)
        const outcome = change(entries)

        await writeAtomically(this.path, entries)
        this.entries = entries

        return outcome
      } finally {
        await release()
      }
    })

    // Kept as the tail whether it worked or not, so one failure does not wedge every later write.
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** A name for an offline agent. Deliberately Mojang-shaped - letters, digits and underscores, under
 * sixteen characters - because plenty of offline servers still enforce that. */
function offlineName(): string {
  return `Osmium_${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

async function load(path: string): Promise<Entry[]> {
  let raw: string

  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list of accounts`)

  return parsed as Entry[]
}

