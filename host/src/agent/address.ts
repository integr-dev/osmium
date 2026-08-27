import { promises as dns } from 'node:dns'

import { log, reason } from '../log.ts'

/**
 * Working out where a server address actually points.
 *
 * **Done here rather than by the protocol library.** node-minecraft-protocol looks the SRV record up
 * itself, but swallows a failed lookup and connects to port 25565 instead - which on an SRV-based
 * server is not the server. The failure that produces is a bare connection reset with nothing in it
 * to act on, and it takes the version check down with it, because that is a ping to the same wrong
 * port.
 */

/** The port Minecraft uses when nobody says otherwise, and the one an SRV record overrides.
 *
 * A port of 25565 is treated as "none given", the same rule the vanilla client follows - and the
 * same one Osmium's backend produces, since it appends this when an operator types a bare hostname. */
const DEFAULT_PORT = 25565

/** Resolvers to fall back on when this machine's own cannot answer.
 *
 * `dns.resolveSrv` talks to the configured nameserver directly rather than going through the
 * operating system, so a host whose resolver is a local proxy that refuses those queries can look up
 * an address perfectly well and still never find its SRV record. Set `OSMIUM_DNS` to something
 * closer to home, or to nothing at all to keep every lookup on this machine.
 */
const FALLBACK = (process.env['OSMIUM_DNS'] ?? '1.1.1.1,8.8.8.8')
  .split(',')
  .map((server) => server.trim())
  .filter(Boolean)

export interface Endpoint {
  host: string
  port: number
}

/**
 * Where to actually connect, for an address an operator typed.
 *
 * An explicit port is obeyed and nothing is looked up - naming one is how you say "this exact
 * socket". Otherwise the SRV record decides, and a server without one keeps the default port.
 */
export async function locate(address: string): Promise<Endpoint> {
  const { host, port } = split(address)

  if (port !== undefined && port !== DEFAULT_PORT) return { host, port }

  const record = await srv(host)
  if (!record) return { host, port: DEFAULT_PORT }

  log.debug(`${host} points at ${record.host}:${record.port}`)
  return record
}

/** Splits `host:port`, ignoring a port that is not one. */
export function split(address: string): { host: string; port: number | undefined } {
  const colon = address.lastIndexOf(':')
  if (colon === -1) return { host: address, port: undefined }

  const port = Number(address.slice(colon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { host: address, port: undefined }

  return { host: address.slice(0, colon), port }
}

/**
 * The Minecraft SRV record for a hostname, or nothing when there is none.
 *
 * Two different "no" answers, kept apart: a domain that says it has no such record is answered
 * honestly and immediately, while a resolver that cannot be reached at all is not an answer about
 * the domain and is retried elsewhere.
 */
async function srv(host: string): Promise<Endpoint | undefined> {
  const name = `_minecraft._tcp.${host}`

  try {
    return best(await dns.resolveSrv(name))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code

    // The domain answered, and the answer is that it has no SRV record.
    if (code === 'ENOTFOUND' || code === 'ENODATA') return undefined

    log.debug(`This machine's resolver could not look up ${name}: ${reason(err)}`)
  }

  for (const server of FALLBACK) {
    // The promise-flavoured resolver, not the callback one of the same name.
    const resolver = new dns.Resolver()
    resolver.setServers([server])

    try {
      const found = best(await resolver.resolveSrv(name))
      log.info(`Looked ${name} up through ${server}, because this machine's resolver would not`)
      return found
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOTFOUND' || code === 'ENODATA') return undefined

      log.debug(`${server} could not look up ${name} either: ${reason(err)}`)
    }
  }

  return undefined
}

/** Lowest priority wins, as SRV specifies. Weight is ignored: these are one server's own records,
 * not a pool to balance across. */
function best(records: { name: string; port: number; priority: number }[]): Endpoint | undefined {
  const chosen = records.reduce<(typeof records)[number] | undefined>(
    (winner, record) => (winner === undefined || record.priority < winner.priority ? record : winner),
    undefined,
  )

  return chosen && { host: chosen.name, port: chosen.port }
}
