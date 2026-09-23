import { describe, expect, it } from 'vitest'
import type { BuildResponse } from '../api/builds'
import type { BuildJob } from '../api/jobs'
import type { Region } from '../api/regions'
import { buildBoxes } from './buildBoxes'

const SERVER = 'mc.example.com'
const OVERWORLD = 'overworld'

function plan(overrides: Partial<BuildResponse> = {}): BuildResponse {
  return {
    id: 1,
    name: 'north tower',
    schematicId: 1,
    schematicName: 'tower',
    placement: { x: 100, y: 64, z: -30 },
    substitutions: [],
    placed: true,
    serverAddress: SERVER,
    dimension: OVERWORLD,
    rotation: 0,
    size: { x: 10, y: 4, z: 3 },
    createdBy: 'root',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function job(overrides: Partial<BuildJob> = {}): BuildJob {
  return {
    id: 7,
    type: 'BUILD',
    name: 'north tower',
    buildId: 1,
    regionId: null,
    schematicId: 1,
    schematicName: 'tower',
    serverAddress: SERVER,
    state: 'ACTIVE',
    splitMode: 'COLUMNS',
    requestedParts: 2,
    placement: { x: 100, y: 64, z: -30 },
    rotation: 90,
    dimension: OVERWORLD,
    size: { x: 10, y: 4, z: 3 },
    regionMax: null,
    totalBlocks: 40,
    blocksPlaced: 0,
    pool: [],
    substitutions: [],
    segments: [],
    createdBy: 'root',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    ...overrides,
  }
}

function region(overrides: Partial<Region> = {}): Region {
  return {
    id: 9,
    type: 'EXCAVATE',
    name: 'the pit',
    serverAddress: SERVER,
    dimension: OVERWORLD,
    placed: true,
    placement: { x: -10, y: 60, z: 5 },
    regionMax: { x: -2, y: 64, z: 13 },
    size: { x: 8, y: 4, z: 8 },
    blocks: 256,
    height: 60,
    createdBy: 'root',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('buildBoxes', () => {
  it('draws a placed plan where it says it is, dashed', () => {
    const [box] = buildBoxes([plan()], [], SERVER, OVERWORLD)

    expect(box).toMatchObject({ id: 'plan-1', label: 'north tower', planned: true })
    expect(box!.box).toEqual({ west: 100, east: 109, north: -30, south: -28, low: 64, high: 67 })
  })

  /** A plan that names no world has not said which map it belongs on, so it is on none of them. */
  it('leaves out a plan for another server, another world, or none', () => {
    const plans = [
      plan({ id: 2, serverAddress: 'other.example.com' }),
      plan({ id: 3, dimension: 'the_nether' }),
      plan({ id: 4, serverAddress: null }),
      plan({ id: 5, placement: null }),
    ]

    expect(buildBoxes(plans, [], SERVER, OVERWORLD)).toEqual([])
  })

  it('draws a job solid, turned the way it was started', () => {
    const [box] = buildBoxes([], [job()], SERVER, OVERWORLD)

    expect(box).toMatchObject({ id: 'job-7', planned: false })
    // A quarter turn trades width for depth; the corner stays on the anchor.
    expect(box!.box).toEqual({ west: 100, east: 102, north: -30, south: -21, low: 64, high: 67 })
  })

  /** Half-open on the wire, as the host is told them; inclusive here, like every block range drawn. */
  it('carries a job’s pieces, inclusive, with the finished ones marked', () => {
    const segment = (minX: number, maxX: number, state: string) =>
      ({ minX, maxX, minY: 64, maxY: 68, minZ: -30, maxZ: -27, state }) as unknown as BuildJob['segments'][number]

    const [box] = buildBoxes([], [job({ segments: [segment(100, 102, 'DONE'), segment(102, 103, 'BUILDING')] })], SERVER, OVERWORLD)

    expect(box!.sections).toEqual([
      { box: { west: 100, east: 101, north: -30, south: -28, low: 64, high: 67 }, done: true },
      { box: { west: 102, east: 102, north: -30, south: -28, low: 64, high: 67 }, done: false },
    ])
  })

  it('divides no plan: a plan is not cut until a job of it starts', () => {
    expect(buildBoxes([plan()], [], SERVER, OVERWORLD)[0]!.sections).toEqual([])
  })

  it('draws a plan being built here once, as its job', () => {
    const boxes = buildBoxes([plan()], [job()], SERVER, OVERWORLD)

    expect(boxes.map((box) => box.id)).toEqual(['job-7'])
  })

  it('keeps a paused job and drops a finished one', () => {
    expect(buildBoxes([], [job({ state: 'PAUSED' })], SERVER, OVERWORLD)).toHaveLength(1)
    expect(buildBoxes([], [job({ state: 'DONE' })], SERVER, OVERWORLD)).toHaveLength(0)
  })

  /** Jobs from before plans named a world were all built in the overworld. */
  it('puts a job that named no world in the overworld', () => {
    expect(buildBoxes([], [job({ dimension: null })], SERVER, OVERWORLD)).toHaveLength(1)
    expect(buildBoxes([], [job({ dimension: null })], SERVER, 'the_end')).toHaveLength(0)
  })

  /**
   * A region job *is* its box, where a build's is the footprint of a turned file. So it is drawn
   * from the two corners it was started with and the schematic arithmetic never runs.
   */
  it('draws a region job from its own corners', () => {
    const dig = job({
      id: 9,
      type: 'EXCAVATE',
      name: 'the pit',
      buildId: null,
      regionId: 9,
      schematicId: null,
      schematicName: null,
      size: null,
      rotation: 0,
      placement: { x: -10, y: 60, z: 5 },
      regionMax: { x: -2, y: 64, z: 13 },
    })

    const [box] = buildBoxes([], [dig], SERVER, OVERWORLD)

    expect(box).toMatchObject({ id: 'job-9', label: 'the pit', type: 'EXCAVATE', planned: false })
    // Half-open on the wire, inclusive here, like every block range drawn.
    expect(box!.box).toEqual({ west: -10, east: -3, north: 5, south: 12, low: 60, high: 63 })
  })

  /** A job with neither a size nor a region describes no box, and a box is what this returns. */
  it('leaves out a job it cannot place', () => {
    expect(buildBoxes([], [job({ size: null })], SERVER, OVERWORLD)).toEqual([])
  })

  /**
   * A region plan is dashed like a build plan, in its own kind's colour — and, like one, it is
   * drawn as its job once there is one, rather than twice.
   */
  it('draws a region plan dashed, and drops it once a job of it is running', () => {
    const quarry = region()

    const [box] = buildBoxes([], [], SERVER, OVERWORLD, [quarry])
    expect(box).toMatchObject({ id: 'region-9', label: 'the pit', type: 'EXCAVATE', planned: true })
    expect(box!.box).toEqual({ west: -10, east: -3, north: 5, south: 12, low: 60, high: 63 })

    const working = job({ id: 3, type: 'EXCAVATE', buildId: null, regionId: 9, size: null, regionMax: { x: -2, y: 64, z: 13 }, placement: { x: -10, y: 60, z: 5 } })
    expect(buildBoxes([], [working], SERVER, OVERWORLD, [quarry]).map((drawn) => drawn.id)).toEqual([
      'job-3',
    ])
  })

  it('leaves out a region for another server or another world', () => {
    expect(buildBoxes([], [], SERVER, OVERWORLD, [region({ serverAddress: 'other.example.com' })])).toEqual([])
    expect(buildBoxes([], [], SERVER, OVERWORLD, [region({ dimension: 'the_nether' })])).toEqual([])
  })

  /** The map and the agents say `overworld`; plans written earlier say `minecraft:overworld`. One world. */
  it('matches a world however it is spelled', () => {
    expect(buildBoxes([plan({ dimension: 'minecraft:overworld' })], [], SERVER, 'overworld')).toHaveLength(1)
    expect(buildBoxes([], [job({ dimension: 'minecraft:overworld' })], SERVER, 'overworld')).toHaveLength(1)
  })
})
