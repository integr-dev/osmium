import { gunzipSync } from 'node:zlib'

import { describe, expect, it, vi } from 'vitest'

import { AgentViewer, spiral, type ViewerEvent } from '../src/agent/viewer.ts'

/**
 * What the viewer actually puts on the wire when it follows an agent.
 *
 * The unit tests either side of this one check the pieces; this checks the thing they add up to,
 * because every way this has been wrong so far has been a column that was walked over, considered,
 * and then quietly not sent - which no test of `spiral` or `within` alone would notice.
 */

const VIEW_DISTANCE = 6

/** Enough of mineflayer for the viewer to follow. The world has every column. */
function fakeBot(at = { x: 8, y: 64, z: 8 }) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  return {
    version: '26.1',
    game: { minY: -64, height: 384 },
    entity: { id: 1, position: { ...at }, yaw: 0, pitch: 0, width: 0.6, height: 1.8 },
    entities: {},
    world: {
      getColumnAt: (pos: { x: number; z: number }) =>
        Promise.resolve({ toJson: () => JSON.stringify({ at: [pos.x, pos.z] }) }),
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event)
      if (existing) existing.push(listener)
      else listeners.set(event, [listener])
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      listeners.set(event, existing.filter((candidate) => candidate !== listener))
    },
    fire(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
}

function eventsIn(frames: Buffer[]): ViewerEvent[] {
  return frames.flatMap((frame) => {
    const body = frame.subarray(6)
    const json = (frame.readUInt8(1) & 0x01) === 0x01 ? gunzipSync(body) : body
    return JSON.parse(json.toString('utf8')) as ViewerEvent[]
  })
}

function columnsIn(frames: Buffer[]): string[] {
  return eventsIn(frames)
    .filter((event) => event.name === 'loadChunk')
    .map((event) => (event.name === 'loadChunk' ? `${event.data.x},${event.data.z}` : ''))
}

/** Where the spiral says a full view around `centre` should be, in block coordinates. */
function expectedColumns(centre: { x: number; z: number }): Set<string> {
  return new Set(spiral(VIEW_DISTANCE).map(({ x, z }) => `${(centre.x + x) * 16},${(centre.z + z) * 16}`))
}

describe('AgentViewer fill', () => {
  it('sends every column in view, once', async () => {
    vi.useFakeTimers()
    const frames: Buffer[] = []
    const bot = fakeBot()
    const viewer = new AgentViewer(1, bot as never, (frame) => frames.push(frame))

    viewer.start()
    await vi.advanceTimersByTimeAsync(10_000)
    viewer.stop()
    vi.useRealTimers()

    const sent = columnsIn(frames)
    const wanted = expectedColumns({ x: 0, z: 0 })

    const missing = [...wanted].filter((column) => !sent.includes(column))
    expect(missing, `never sent ${missing.length} of ${wanted.size} columns`).toEqual([])
    expect(new Set(sent).size, 'a column was sent more than once').toBe(sent.length)
  })

  it('states the version and the world bounds before any column', async () => {
    vi.useFakeTimers()
    const frames: Buffer[] = []
    const viewer = new AgentViewer(1, fakeBot() as never, (frame) => frames.push(frame))

    viewer.start()
    await vi.advanceTimersByTimeAsync(10_000)
    viewer.stop()
    vi.useRealTimers()

    const events = eventsIn(frames)
    const version = events.findIndex((event) => event.name === 'version')
    const column = events.findIndex((event) => event.name === 'loadChunk')

    expect(version).toBeGreaterThanOrEqual(0)
    expect(version).toBeLessThan(column)
    expect(events[version]).toEqual({ name: 'version', data: { version: '26.1', minY: -64, height: 384 } })
  })

  it('fills in the new edge after the agent crosses into the next column', async () => {
    vi.useFakeTimers()
    const frames: Buffer[] = []
    const bot = fakeBot()
    const viewer = new AgentViewer(1, bot as never, (frame) => frames.push(frame))

    viewer.start()
    await vi.advanceTimersByTimeAsync(10_000)
    frames.length = 0

    // One column east, which should retire the far west edge and ask for a new east one.
    bot.entity.position.x = 8 + 16
    bot.fire('move')
    await vi.advanceTimersByTimeAsync(10_000)
    viewer.stop()
    vi.useRealTimers()

    const sent = new Set(columnsIn(frames))
    const wanted = expectedColumns({ x: 1, z: 0 })
    const arrived = expectedColumns({ x: 0, z: 0 })

    const missing = [...wanted].filter((column) => !arrived.has(column) && !sent.has(column))
    expect(missing, `never sent ${missing.length} newly visible columns`).toEqual([])
  })

  it('stops sending once nobody is watching', async () => {
    vi.useFakeTimers()
    const frames: Buffer[] = []
    const viewer = new AgentViewer(1, fakeBot() as never, (frame) => frames.push(frame))

    viewer.start()
    viewer.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()

    expect(columnsIn(frames)).toEqual([])
  })
})
