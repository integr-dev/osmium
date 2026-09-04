import { constants } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { log } from '../log.ts'

/**
 * Writing a file two processes share.
 *
 * Both of this host's stores are edited by hand while the router is running — accounts through
 * `osmium-link`, proxies the same way — so both need the same two things: an exclusive lock across
 * a read-modify-write, and a write that cannot leave a half-file behind. They lived in the account
 * store and are here because there are two callers now; one locking primitive with two subtly
 * different copies is the version of this that goes wrong quietly.
 */

/** How long a lock file may sit untouched before it is taken to be a crashed writer's. The critical
 * section is a read, a write and a rename, so anything approaching this is not still running. */
const STALE = 10_000
const RETRY = 25

/**
 * An exclusive lock on a store, held across a read-modify-write and no longer.
 *
 * A separate file from the store itself, because the store is replaced by a rename: locking the
 * store directly would leave each writer holding a file the other had already replaced.
 *
 * Exclusive *creation* is the primitive - `O_EXCL` fails when the file is there - because Node has
 * no portable advisory locking. The cost is that a process killed mid-write leaves the file behind,
 * so one older than {@link STALE} is taken from it.
 */
export async function lock(path: string): Promise<() => Promise<void>> {
  const file = `${path}.lock`
  await mkdir(dirname(path), { recursive: true })

  for (;;) {
    try {
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.close()

      return async () => {
        await rm(file, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      const held = await stat(file).catch(() => undefined)

      if (held && Date.now() - held.mtimeMs > STALE) {
        log.warn(`Taking a stale lock on ${file}`)
        await rm(file, { force: true })
        continue
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY))
    }
  }
}

/**
 * Writes a store out, readable only by its owner.
 *
 * To a neighbouring file and then renamed, which is atomic on the same filesystem: a crash halfway
 * through leaves the old store intact rather than a truncated one holding none of the credentials
 * the fleet runs on. Callers hold the lock; this does not take it.
 */
export async function writeAtomically(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })

  const temporary = `${path}.tmp`
  // Written 0600 from the start, so the file is never briefly world readable under any name.
  await writeFile(temporary, JSON.stringify(content, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}
