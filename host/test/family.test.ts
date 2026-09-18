import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { familyFrom, pinned } from '../src/agent/family.ts'

describe('the address family', () => {
  it('reads the two it knows, and nothing else', () => {
    expect(familyFrom('ipv4', 'test')).toBe('ipv4')
    expect(familyFrom('ipv6', 'test')).toBe('ipv6')
  })

  /** A setting this build does not understand connects the ordinary way rather than not at all. */
  it('leaves the choice to the machine for anything else', () => {
    expect(familyFrom(undefined, 'test')).toBe('auto')
    expect(familyFrom('', 'test')).toBe('auto')
    expect(familyFrom('   ', 'test')).toBe('auto')
    expect(familyFrom('ipv7', 'test')).toBe('auto')
  })

  it('leaves the socket alone when nothing is pinned', () => {
    expect(pinned('auto', 'example.com', 25565).connect).toBeUndefined()
  })
})

describe('dialling a pinned family', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  function listening(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      server = createServer()
      server.on('error', reject)
      server.listen(0, host, () => resolve((server!.address() as { port: number }).port))
    })
  }

  /** The client's own handshake waits on `connect`, and a socket handed over already connected
   * has fired its own before anybody could hear it. */
  it('hands over a connected socket and says so', async () => {
    const port = await listening('127.0.0.1')

    const events: string[] = []
    let handed: Socket | undefined
    const client = {
      setSocket: (socket: Socket) => {
        handed = socket
        events.push('socket')
      },
      emit: (name: string) => void events.push(name),
    }

    pinned('ipv4', '127.0.0.1', port).connect!(client)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(events).toEqual(['socket', 'connect'])
    expect(handed?.remotePort).toBe(port)
    handed?.destroy()
  })

  /** Reported as the client's own error, which is the path a refused connection already takes. */
  it('reports a refusal the way a refused connection is reported', async () => {
    const port = await listening('127.0.0.1')
    server?.close()
    server = undefined

    const errors: unknown[] = []
    const client = {
      setSocket: () => expect.fail('nothing should be handed over'),
      emit: (name: string, value?: unknown) => {
        if (name === 'error') errors.push(value)
      },
    }

    pinned('ipv4', '127.0.0.1', port).connect!(client)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('ipv4')
  })

  /** The point of the setting: a name that also has an AAAA record is dialled over IPv4 anyway. */
  it('will not reach a server listening only on the other family', async () => {
    let port: number
    try {
      port = await listening('::1')
    } catch {
      return // No IPv6 loopback on this machine, which is itself the reason the setting exists.
    }

    const errors: unknown[] = []
    const client = {
      setSocket: () => expect.fail('IPv4 must not reach an IPv6-only listener'),
      emit: (name: string, value?: unknown) => {
        if (name === 'error') errors.push(value)
      },
    }

    pinned('ipv4', 'localhost', port).connect!(client)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(errors).toHaveLength(1)
  })
})
