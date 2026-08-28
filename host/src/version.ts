import { createRequire } from 'node:module'

/**
 * What this build calls itself.
 *
 * Read from `package.json` once, here, rather than threaded from the entry point to everything that
 * wants it. Two places do: the heartbeat, which is how the backend records what a host is running,
 * and an agent answering `!osm id` in game — and a version that disagreed between the two would be
 * worse than no version at all.
 */
export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version
