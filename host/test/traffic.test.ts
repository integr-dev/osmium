import { describe, expect, it } from 'vitest'

import { socketOf, Traffic } from '../src/agent/traffic.ts'

describe('traffic', () => {
  it('reads the open session off its socket', () => {
    const traffic = new Traffic()

    expect(traffic.total({ bytesWritten: 10, bytesRead: 200 })).toEqual({ sent: 10, received: 200 })
    expect(traffic.total(undefined)).toEqual({ sent: 0, received: 0 })
  })

  it('keeps what an ended session moved', () => {
    const traffic = new Traffic()

    traffic.retire({ bytesWritten: 10, bytesRead: 200 })
    expect(traffic.total(undefined)).toEqual({ sent: 10, received: 200 })

    // The next session's socket counts from zero again.
    expect(traffic.total({ bytesWritten: 5, bytesRead: 5 })).toEqual({ sent: 15, received: 205 })
  })

  it('ends a session that never opened a socket without losing anything', () => {
    const traffic = new Traffic()
    traffic.retire({ bytesWritten: 1, bytesRead: 1 })
    traffic.retire(undefined)

    expect(traffic.total(undefined)).toEqual({ sent: 1, received: 1 })
  })

  it('finds the socket under a bot, and nothing under no bot', () => {
    const socket = { bytesRead: 1, bytesWritten: 2 }

    expect(socketOf({ _client: { socket } })).toBe(socket)
    expect(socketOf(undefined)).toBeUndefined()
    expect(socketOf({ _client: {} })).toBeUndefined()
  })
})
