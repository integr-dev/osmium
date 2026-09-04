import { Agent as HttpsAgent } from 'node:https'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { SocksClient, type SocksProxy } from 'socks'

import { log, reason } from '../log.ts'
import { lock, writeAtomically } from '../token/files.ts'

/**
 * The proxies this host can route an agent through.
 *
 * **Named here, chosen there.** The backend and the interface know a proxy by its name and nothing
 * else; the address, and the username and password it may need, live in a file on this machine
 * beside the account store. That is the same bargain the accounts themselves are under - Osmium is
 * told what a host *can* do, never what it holds - and it is the reason this is a file rather than
 * a setting: a setting is stored in Postgres, shown in a form, and relayed over a socket, which is
 * three places a proxy password has no business being.
 *
 * What an agent carries is `connect.proxy`, holding one of these names. Everything else is here.
 */

/** How to speak to the proxy. Anything a provider sells is one of these. */
export type ProxyKind = 'socks5' | 'socks4' | 'http' | 'https'

const KINDS: ProxyKind[] = ['socks5', 'socks4', 'http', 'https']

/** One proxy, as the file on this host describes it. */
export interface ProxyEntry {
  name: string
  kind: ProxyKind
  host: string
  /** Any port. Providers hand out 1080, 8080, 9050 and whatever else they felt like. */
  port: number
  username?: string
  password?: string
}

/** What the backend is told about one: enough to choose it by, and nothing to connect with. */
export interface AdvertisedProxy {
  name: string
  kind: ProxyKind
  /** Where it is. The address is not a secret - the credential is - and an operator picking between
   * four proxies is picking between four places. */
  host: string
  port: number
  /** Whether it authenticates. Said rather than shown: the password stays on this machine. */
  authenticated: boolean
}

/** Where the file lives, beside the accounts and the token cache. */
export function proxiesPath(): string {
  return process.env['OSMIUM_PROXIES'] ?? '/agent/proxies.json'
}

/**
 * Every proxy this host holds, by name.
 *
 * Read once at startup and kept: a proxy is chosen while a connection is being opened, which is not
 * a moment to be reading and parsing a file, and a machine whose proxies change has an operator on
 * it who can restart the host.
 *
 * **A malformed entry is dropped, not fatal.** One bad line in the file must not cost the host every
 * other proxy in it, nor stop the host from starting at all - an agent that names the dropped one
 * fails to connect and says exactly that, which is a smaller failure and a legible one.
 */
export class Proxies {
  private constructor(private readonly held: Map<string, ProxyEntry>) {}

  static async open(path: string): Promise<Proxies> {
    let entries: ProxyEntry[]
    try {
      entries = await loadProxies(path)
    } catch (err) {
      // A file this host cannot read is not a reason to refuse to start: an agent that names a
      // proxy fails to connect and says so, which is smaller and more legible than a dead host.
      log.warn(`Ignoring ${path}: ${reason(err)}`)
      return new Proxies(new Map())
    }

    const held = new Map(entries.map((proxy) => [proxy.name, proxy]))

    log.info(
      held.size
        ? `Holding ${held.size} prox${held.size === 1 ? 'y' : 'ies'}: ${[...held.keys()].join(', ')}`
        : `Holding no proxies; agents will connect from this machine's own address`,
    )
    return new Proxies(held)
  }

  /** For the handshake. Names, kinds and addresses - never a credential. */
  advertised(): AdvertisedProxy[] {
    return [...this.held.values()].map((proxy) => ({
      name: proxy.name,
      kind: proxy.kind,
      host: proxy.host,
      port: proxy.port,
      authenticated: proxy.username !== undefined,
    }))
  }

  /** The proxy an agent named, or undefined for a name this host does not have. */
  find(name: string | undefined): ProxyEntry | undefined {
    return name ? this.held.get(name) : undefined
  }

  has(name: string): boolean {
    return this.held.has(name)
  }
}

/** One entry of the file, if it is one. */
function read(entry: unknown): ProxyEntry | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const fields = entry as Record<string, unknown>

  const name = typeof fields['name'] === 'string' ? fields['name'].trim() : ''
  const host = typeof fields['host'] === 'string' ? fields['host'].trim() : ''
  const port = typeof fields['port'] === 'number' ? fields['port'] : Number(fields['port'])
  const kind = typeof fields['kind'] === 'string' ? fields['kind'].trim().toLowerCase() : 'socks5'

  if (!name || !host) {
    log.warn('Ignoring a proxy with no name or no host')
    return undefined
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log.warn(`Ignoring proxy '${name}': ${String(fields['port'])} is not a port`)
    return undefined
  }
  if (!KINDS.includes(kind as ProxyKind)) {
    log.warn(`Ignoring proxy '${name}': '${kind}' is not one of ${KINDS.join(', ')}`)
    return undefined
  }

  const proxy: ProxyEntry = { name, kind: kind as ProxyKind, host, port }

  // Assigned rather than set to undefined: an absent credential and one written as `null` in the
  // file are the same thing, and the difference is not one this has to carry around.
  if (typeof fields['username'] === 'string' && fields['username']) proxy.username = fields['username']
  if (typeof fields['password'] === 'string') proxy.password = fields['password']

  return proxy
}

/**
 * Opens a TCP connection to somewhere, through a proxy.
 *
 * Both families end in the same thing - a socket already talking to the destination - which is what
 * node-minecraft-protocol's `connect` hook wants and what a TLS session can be wrapped around.
 */
export function dial(proxy: ProxyEntry, host: string, port: number): Promise<Socket> {
  return proxy.kind === 'socks4' || proxy.kind === 'socks5'
    ? throughSocks(proxy, host, port)
    : throughConnect(proxy, host, port)
}

function throughSocks(proxy: ProxyEntry, host: string, port: number): Promise<Socket> {
  const target: SocksProxy = {
    host: proxy.host,
    port: proxy.port,
    type: proxy.kind === 'socks4' ? 4 : 5,
  }
  // SOCKS4 calls it a user id and SOCKS5 a username; the library takes both under `userId`.
  if (proxy.username !== undefined) target.userId = proxy.username
  if (proxy.password !== undefined) target.password = proxy.password

  return SocksClient.createConnection({
    proxy: target,
    command: 'connect',
    destination: { host, port },
    timeout: DIAL_TIMEOUT,
  }).then((info) => info.socket)
}

/**
 * An HTTP proxy, through its `CONNECT` verb.
 *
 * Hand-written rather than pulled in, because Node's own client speaks it: a `CONNECT` request
 * emits the raw tunnelled socket rather than a response body, and that socket is the whole of what
 * this needs. The alternative was a dependency whose entire job is to hand back the same object.
 */
function throughConnect(proxy: ProxyEntry, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const send = proxy.kind === 'https' ? httpsRequest : httpRequest
    const headers: Record<string, string> = { host: `${host}:${port}` }

    if (proxy.username !== undefined) {
      const pair = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')
      headers['proxy-authorization'] = `Basic ${pair}`
    }

    const request = send({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout: DIAL_TIMEOUT,
    })

    request.once('connect', (response, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`the proxy answered ${response.statusCode} ${response.statusMessage ?? ''}`.trim()))
        return
      }
      // Cleared, or the tunnel would be torn down mid-session by the deadline for opening it.
      socket.setTimeout(0)
      resolve(socket)
    })

    request.once('timeout', () => request.destroy(new Error('the proxy did not answer')))
    request.once('error', reject)
    request.end()
  })
}

/** How long a proxy has to put the connection through. Beyond this it is not going to. */
const DIAL_TIMEOUT = 15_000

/**
 * An HTTPS agent that dials through a proxy.
 *
 * For the **session-server join** - the request that proves to Mojang that this account is joining
 * this server - which node-minecraft-protocol makes over node-fetch with whatever `agent` it was
 * given. Without it the game traffic goes through the proxy and that one request does not, which
 * announces the host's own address at exactly the moment somebody chose a proxy to avoid it.
 *
 * Subclassed rather than fetched from a package: the whole of it is "open the socket differently",
 * and `createConnection` is the one method that says how.
 */
export function httpsAgentFor(proxy: ProxyEntry): HttpsAgent {
  const agent = new HttpsAgent()

  // Written onto the instance rather than subclassed, and cast for it. `createConnection` is a
  // documented extension point that Node's own typings describe as returning a socket, while the
  // asynchronous form - the one that dials through something - answers a callback instead. Both
  // are supported at runtime; only one of them is typed.
  const dialing = (
    options: { host?: string | null; port?: number | null; servername?: string },
    callback: (err: Error | null, socket?: Socket) => void,
  ): void => {
    const host = options.host ?? ''
    const port = Number(options.port ?? 443)

    dial(proxy, host, port).then(
      // Wrapped here rather than by the caller: what this hands back has to be the TLS session, and
      // the name to verify the certificate against is the destination's, never the proxy's.
      (socket) => callback(null, tlsConnect({ socket, servername: options.servername ?? host })),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    )
  }

  ;(agent as unknown as { createConnection: typeof dialing }).createConnection = dialing
  return agent
}

/**
 * What node-minecraft-protocol needs to put one session through a proxy.
 *
 * `connect` replaces the socket it would have opened itself; `agent` is for the session-server call
 * it makes over HTTPS. The library calls the first and hands the second to node-fetch, so both are
 * simply options on `createBot` - and `ping` takes the same `connect`, which is what keeps the
 * version check from touching the server directly.
 *
 * **The socket arrives already connected**, so `connect` is emitted by hand: the default path opens
 * a raw socket and lets its own `connect` event through, and a tunnelled one has already had that
 * event before we ever see it. Without this the client waits forever for a connection it has.
 */
export function routed(proxy: ProxyEntry, host: string, port: number): { connect: (client: ProtocolClient) => void; agent: HttpsAgent } {
  return {
    connect: (client) => {
      dial(proxy, host, port).then(
        (socket) => {
          client.setSocket(socket)
          client.emit('connect')
        },
        // Reported as the client's own error, which is the path a refused connection already takes:
        // the agent hears about it exactly where it hears about a server that would not have it.
        (err: unknown) => client.emit('error', new Error(`proxy '${proxy.name}': ${reason(err)}`)),
      )
    },
    agent: httpsAgentFor(proxy),
  }
}

/** As much of node-minecraft-protocol's client as the hook above touches. */
interface ProtocolClient {
  setSocket(socket: Socket): void
  emit(name: string, value?: unknown): void
}

/**
 * The proxy file, with a way to change it.
 *
 * Separate from {@link Proxies} because the two have opposite jobs. The router reads the file once
 * and never writes; `osmium-link` writes it while the router is running, so every change here is a
 * locked read-modify-write against what is on disk rather than a dump of what this process last
 * saw — the same bargain the account store is under, and the same primitives.
 *
 * **The router will not see a change until it restarts.** The file is read at startup, and what it
 * advertises to the backend is what it read; nothing here reaches into a running process. Every
 * command that changes the file says so.
 */
export class ProxyStore {
  private constructor(
    readonly path: string,
    private entries: ProxyEntry[],
  ) {}

  static async open(path: string): Promise<ProxyStore> {
    return new ProxyStore(path, await loadProxies(path))
  }

  /** Everything in the file, in the order it was written. */
  list(): ProxyEntry[] {
    return [...this.entries]
  }

  /**
   * Adds one, refusing a name that is already there.
   *
   * Refused rather than replaced: a name is what an agent's `connect.proxy` holds, so overwriting
   * one silently repoints every agent using it at somewhere else. Removing and re-adding is two
   * deliberate acts, which is the right number for that.
   */
  async add(proxy: ProxyEntry): Promise<void> {
    await this.mutate((entries) => {
      if (entries.some((held) => held.name === proxy.name)) {
        throw new Error(`there is already a proxy called '${proxy.name}'`)
      }
      entries.push(proxy)
    })
  }

  /** Drops one by name. False when there was nothing under it. */
  async remove(name: string): Promise<boolean> {
    return this.mutate((entries) => {
      const at = entries.findIndex((held) => held.name === name)
      if (at === -1) return false

      entries.splice(at, 1)
      return true
    })
  }

  /** The lock, the read, the change, the write - in that order, like the account store. */
  private async mutate<T>(change: (entries: ProxyEntry[]) => T): Promise<T> {
    const release = await lock(this.path)

    try {
      // What is on disk now, not what we last saw: the file is edited by hand as well as by this.
      const entries = await loadProxies(this.path)
      const outcome = change(entries)

      await writeAtomically(this.path, entries)
      this.entries = entries

      return outcome
    } finally {
      await release()
    }
  }
}

/**
 * The file as a list, dropping anything unusable.
 *
 * Shared by the router and the store so both agree on what counts as an entry: a proxy the router
 * would refuse to dial is one the CLI must not report as held.
 */
async function loadProxies(path: string): Promise<ProxyEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${path} is not JSON (${reason(err)})`)
  }

  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list of proxies`)

  const held: ProxyEntry[] = []
  for (const entry of parsed) {
    const proxy = read(entry)
    if (proxy && !held.some((already) => already.name === proxy.name)) held.push(proxy)
  }
  return held
}

/**
 * Whether a name, kind, host and port describe something dialable — the same checks the file
 * reader makes, so the CLI refuses at the prompt what the router would refuse at startup.
 *
 * Returns the reason it is not, or undefined when it is.
 */
export function unusable(fields: {
  name: string
  kind: string
  host: string
  port: number
}): string | undefined {
  if (!fields.name.trim()) return 'a proxy needs a name'
  if (!fields.host.trim()) return 'a proxy needs a host'
  if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535) {
    return `${fields.port} is not a port`
  }
  if (!KINDS.includes(fields.kind as ProxyKind)) return `'${fields.kind}' is not one of ${KINDS.join(', ')}`
  return undefined
}

/** The kinds, for a chooser that must offer exactly what this host can speak. */
export function kinds(): ProxyKind[] {
  return [...KINDS]
}
