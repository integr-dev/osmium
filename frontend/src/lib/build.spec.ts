import { describe, expect, it } from 'vitest'
import { buildFigures } from './build'
import type { FleetAgent } from '../stores/agents'

const agent = (placed: number, state: FleetAgent['state'] = 'ONLINE', serverAddress: string | null = 'a:25565') =>
  ({ state, serverAddress, build: { blocksPlaced: placed, task: '' } }) as FleetAgent

describe('build figures', () => {
  it('sums what the given agents placed, and nothing else', () => {
    expect(buildFigures([agent(100), agent(50)], 1000).placed).toBe(150)
    expect(buildFigures([], 1000).placed).toBe(0)
  })

  /** An agent standing in the world having placed nothing is not building. */
  it('rates only agents that are in game and placing', () => {
    expect(buildFigures([agent(100), agent(0)], 1000).perMinute).toBe(38)
    expect(buildFigures([agent(100, 'LINKED')], 1000).perMinute).toBe(0)
  })

  it('has no ETA without a rate', () => {
    expect(buildFigures([agent(0)], 1000).etaMinutes).toBeNull()
    expect(buildFigures([agent(620)], 1000).etaMinutes).toBe(10)
  })

  /** A finished build must not read as 140% done, and a fresh one must not divide by zero. */
  it('stays inside its bounds', () => {
    expect(buildFigures([agent(2000)], 1000).percent).toBe(100)
    expect(buildFigures([agent(10)], 0).percent).toBe(0)
    expect(buildFigures([agent(2000)], 1000).etaMinutes).toBe(0)
  })
})

/**
 * The bug this exists to prevent: a fleet on three servers is building three copies, and dividing
 * the sum by one schematic reported it finished — 100% and no time left — while every server still
 * had hours to go.
 */
describe('what the fleet is working towards', () => {
  const onServer = (server: string | null, placed: number) => agent(placed, 'ONLINE', server)

  it('counts one schematic per server the agents are on', () => {
    const oneServer = buildFigures([onServer('a:25565', 500)], 1000)
    const twoServers = buildFigures([onServer('a:25565', 500), onServer('b:25565', 500)], 1000)

    expect(oneServer.target).toBe(1000)
    expect(twoServers.target).toBe(2000)
  })

  it('does not read as finished when each server is only half done', () => {
    const summary = buildFigures([onServer('a:25565', 500), onServer('b:25565', 500)], 1000)

    expect(summary.percent).toBe(50)
    expect(summary.etaMinutes).toBeGreaterThan(0)
  })

  /** They cannot connect, so they are building nothing and add no target. */
  it('ignores agents assigned nowhere', () => {
    expect(buildFigures([onServer('a:25565', 100), onServer(null, 0)], 1000).target).toBe(1000)
  })

  /** Never zero: a fleet with nothing assigned must not divide by nothing. */
  it('always has a target', () => {
    expect(buildFigures([onServer(null, 0)], 1000).target).toBe(1000)
    expect(buildFigures([], 1000).target).toBe(1000)
  })
})

/**
 * The pooled figure — total remaining over total rate — assumes an agent on one server can help
 * finish the build on another. It cannot. A fleet needing twelve hours on one server and seven on
 * another does not finish in ten.
 */
describe('when the fleet finishes', () => {
  const on = (server: string, placed: number) => agent(placed, 'ONLINE', server)

  it('waits for the slowest server rather than averaging them', () => {
    // 'a' has one builder and 3800 left; 'b' has two builders and 3800 left, so it is twice as fast.
    const fleet = [on('a:25565', 200), on('b:25565', 100), on('b:25565', 100)]

    const alone = buildFigures([on('a:25565', 200)], 4000).etaMinutes
    const together = buildFigures(fleet, 4000).etaMinutes

    expect(alone).toBe(100)
    // Pooled arithmetic would have said (3800 + 3800) / (3 × 38) = 67.
    expect(together).toBe(alone)
  })

  it('never finishes while a server has work and nobody placing', () => {
    const stalled = [on('a:25565', 500), agent(0, 'LINKED', 'b:25565')]

    expect(buildFigures(stalled, 1000).etaMinutes).toBeNull()
  })

  /** A finished server must not hold the estimate open, or the fleet never reports done. */
  it('ignores servers that are already there', () => {
    const mixed = [on('a:25565', 1000), on('b:25565', 620)]

    expect(buildFigures(mixed, 1000).etaMinutes).toBe(10)
  })
})
