import { connect, type Socket } from 'node:net'

import { log, reason } from '../log.ts'

/**
 * Which kind of address a session is allowed to dial.
 *
 * A name with both an A and an AAAA record is reachable two ways, and the two are not always the
 * same server — nor always both working. Node picks one on the operating system's advice, so an
 * agent on a machine whose IPv6 route is broken, or on a server that answers only over IPv4, has no
 * way to say which it wants. This is that setting.
 */
export type Family = 'auto' | 'ipv4' | 'ipv6'

export function familyFrom(value: string | undefined, what: string): Family {
  const wanted = value?.trim()
  if (!wanted) return 'auto'
  if (wanted === 'ipv4' || wanted === 'ipv6') return wanted

  log.warn(`${what}: '${wanted}' is not an address family, connecting either way`)
  return 'auto'
}

/** As much of node-minecraft-protocol's client as the hook below touches. */
interface ProtocolClient {
  setSocket(socket: Socket): void
  emit(name: string, value?: unknown): void
}

/**
 * The options that pin a direct connection to one address family, or none at all for `auto`.
 *
 * **The socket is dialled here rather than the address resolved ahead of it.** Resolving the name to
 * an A record and connecting to the number would work, and would also put that number in the
 * handshake — which is what a proxy in front of the server routes on. A server behind BungeeCord or
 * Velocity would stop recognising which of its backends the agent was asking for. Dialling with the
 * family set keeps the hostname in the handshake and constrains only the socket under it.
 *
 * Shaped like {@link routed} in `proxy.ts` and for the same reason: `createBot` and `ping` both take
 * a `connect`, so one option covers the session and the version check that precedes it. And as
 * there, the socket arrives connected, so the event the client is waiting for is emitted by hand.
 *
 * A proxy route wins over this: the proxy does the dialling, and what it dials with is its own.
 */
export function pinned(family: Family, host: string, port: number): { connect?: (client: ProtocolClient) => void } {
  if (family === 'auto') return {}

  return {
    connect: (client) => {
      const socket = connect({ host, port, family: family === 'ipv4' ? 4 : 6 })

      socket.once('connect', () => {
        client.setSocket(socket)
        client.emit('connect')
      })

      // Reported as the client's own error, which is the path a refused connection already takes:
      // the agent hears about it exactly where it hears about a server that would not have it.
      socket.once('error', (err: unknown) => {
        client.emit('error', new Error(`${family}: ${reason(err)}`))
      })
    },
  }
}
