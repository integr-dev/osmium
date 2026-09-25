import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import minecraftData from 'minecraft-data'

import { log } from '../log.ts'

/**
 * Working out what a server speaks when it will not say.
 *
 * **A masked server names no version at all.** ViaVersion answers a status ping with protocol
 * `9999` — "any client welcome" — and a server behind it is free to put anything in the version
 * name, which is usually a decorated player count. There is nothing in that to negotiate from, so
 * the host used to speak the newest version it knows and hope.
 *
 * Hope is wrong often enough to matter, and it fails *late*: the handshake succeeds, the login
 * succeeds, and the session dies the moment a packet arrives whose shape moved between the version
 * being spoken and the one being served — an item with components is the usual one, which is why an
 * agent can play for an hour and then be unable to rejoin because it picked something up.
 *
 * So a version that will not be told is **found by trying**, and what worked is remembered per
 * server, because the next join should not repeat the search.
 */

/** How many versions one connect will try before giving up and reporting the failure. */
export const ATTEMPTS = 4

/** Where the memory lives, beside the token cache: what a server speaks is host-wide, not an agent's. */
const FILE = 'versions.json'

/**
 * The versions worth trying, newest first.
 *
 * **One per protocol, which is not one per release line.** 1.21.4 and 1.21.11 are both 1.21 and
 * speak different protocols — 769 and 774 — while a release and its point release often share one.
 * The protocol is what a server actually serves, so it is the axis this runs along: grouped by
 * line, a search would try 1.21.11, fail, and skip the seven other 1.21 protocols behind it.
 *
 * Releases only. A snapshot is spoken by nothing an operator is likely to be joining, and a search
 * that spends its attempts on them never reaches a version anybody runs.
 *
 * Newest first: a server too old to understand what we offer refuses the login outright, which is
 * cheap and unmistakable, while a server newer than us hands over a stream we misread.
 */
export function candidates(supported: readonly string[] = minecraftData.supportedVersions.pc): string[] {
  const table = minecraftData.versionsByMinecraftVersion.pc as unknown as Record<
    string,
    { version?: number }[] | { version?: number } | undefined
  >
  const newest = new Map<number, string>()

  for (const version of supported) {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) continue

    const entry = table[version]
    const protocol = Array.isArray(entry) ? entry[0]?.version : entry?.version
    if (typeof protocol !== 'number') continue

    // Oldest first in the list, so a later release on the same protocol replaces an earlier one.
    newest.set(protocol, version)
  }

  return [...newest.entries()].sort(([one], [other]) => other - one).map(([, version]) => version)
}

/**
 * The next version to speak, or nothing when everything worth trying has been.
 *
 * In order: what worked here before, what the ping said, then the list — skipping anything this
 * attempt has already tried. The remembered one goes first because it is evidence rather than a
 * guess: this agent, or another on this host, actually played on it.
 */
export function nextVersion(options: {
  known?: string | undefined
  hinted?: string | undefined
  tried?: readonly string[]
  list?: readonly string[]
}): string | undefined {
  const tried = new Set(options.tried ?? [])
  const order = [options.known, options.hinted, ...(options.list ?? candidates())]

  return order.find((version): version is string => typeof version === 'string' && !tried.has(version))
}

/**
 * What each server turned out to speak, across restarts.
 *
 * Written through on every change rather than on shutdown: a host is stopped by being killed at
 * least as often as it is stopped politely, and a memory that only survives a clean exit is a
 * memory that is empty exactly when the search would cost most.
 *
 * Failing to read or write it is not worth refusing to play over — what it costs is a search that
 * has to happen again — so both ends log and carry on.
 */
export class VersionMemory {
  private readonly file: string | undefined
  private known = new Map<string, string>()

  constructor(directory: string | undefined) {
    this.file = directory ? join(directory, FILE) : undefined
    this.load()
  }

  /** What this server spoke last time an agent got into play on it. */
  recall(address: string): string | undefined {
    return this.known.get(address)
  }

  /** Remembers a version that actually reached play. Nothing to do when it is already what we knew. */
  remember(address: string, version: string): void {
    if (this.known.get(address) === version) return

    this.known.set(address, version)
    this.save()
  }

  /**
   * Forgets what we thought this server spoke.
   *
   * Called when the remembered version stops working: a server that updates is the ordinary reason,
   * and a memory that cannot be wrong is a memory that pins an agent to a version for ever.
   */
  forget(address: string): void {
    if (!this.known.delete(address)) return
    this.save()
  }

  private load(): void {
    if (!this.file) return

    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      for (const [address, version] of Object.entries(stored)) {
        if (typeof version === 'string' && version) this.known.set(address, version)
      }
      if (this.known.size) log.debug(`Remembered what ${this.known.size} server(s) speak`)
    } catch (err) {
      // A missing file is the ordinary case on a fresh host, and is not worth a line.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.debug(`Could not read what servers speak: ${String(err)}`)
      }
    }
  }

  private save(): void {
    if (!this.file) return

    try {
      writeFileSync(this.file, `${JSON.stringify(Object.fromEntries(this.known), null, 2)}\n`)
    } catch (err) {
      log.debug(`Could not write what servers speak: ${String(err)}`)
    }
  }
}
