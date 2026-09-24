import { describe, expect, it } from 'vitest'

import { serialize } from '../src/protocol/serialize.ts'
import { Profiler, type Usage } from '../src/usage.ts'

function parse(raw: string): any {
  return JSON.parse(raw)
}

/**
 * What this host costs the machine it runs on.
 *
 * The numbers themselves cannot be asserted — a test that expects a particular processor reading is
 * a test that fails on a busy build agent — so what is checked is their *shape*: the ranges they
 * must stay inside, and that a reading taken twice is measuring an interval rather than the whole
 * uptime.
 */
describe('the profiler', () => {
  it('reads a machine and a process without inventing anything', () => {
    const usage = new Profiler().read()

    expect(usage.cpu).toBeGreaterThanOrEqual(0)
    // The machine is a percentage of every core together, so this one has a ceiling.
    expect(usage.systemCpu).toBeGreaterThanOrEqual(0)
    expect(usage.systemCpu).toBeLessThanOrEqual(100)

    expect(usage.memory).toBeGreaterThan(0)
    expect(usage.systemMemory).toBeGreaterThan(0)
    expect(usage.systemMemoryTotal).toBeGreaterThanOrEqual(usage.systemMemory)
  })

  /**
   * The first read has nothing behind it, so it reports zero rather than a guess — `process` and
   * `os` both hand back totals since start, and dividing one of those by the elapsed time would
   * describe the whole uptime as if it were this moment.
   */
  it('measures an interval rather than the whole uptime', () => {
    const profiler = new Profiler()

    const first = profiler.read()
    expect(first.cpu).toBe(0)

    // Something to measure. A tight loop is the point: it should not read as idle.
    const until = Date.now() + 30
    while (Date.now() < until) {
      // Deliberately busy.
    }

    const second = profiler.read()
    expect(second.cpu).toBeGreaterThan(0)
  })

  it('never reports a negative, whatever the counters do', () => {
    const readings = [new Profiler().read(), new Profiler().read()]
    for (const usage of readings) {
      for (const value of Object.values(usage)) expect(value).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('a heartbeat carrying one', () => {
  const usage: Usage = {
    cpu: 12.5,
    memory: 300_000_000,
    systemCpu: 44,
    systemMemory: 8_000_000_000,
    systemMemoryTotal: 16_000_000_000,
  }

  it('puts the five numbers on the wire under one key', () => {
    const json = parse(serialize({ kind: 'event', body: { type: 'heartbeat', version: '1.2.3', usage } }))

    expect(json.type).toBe('heartbeat')
    expect(json.payload.hostVersion).toBe('1.2.3')
    expect(json.payload.usage).toEqual(usage)
  })

  /** Optional, so a heartbeat from a host that cannot measure itself is still a heartbeat. */
  it('leaves the key off entirely when there is no reading', () => {
    const json = parse(serialize({ kind: 'event', body: { type: 'heartbeat', version: '1.2.3' } }))

    expect(json.payload.hostVersion).toBe('1.2.3')
    expect('usage' in json.payload).toBe(false)
  })
})
