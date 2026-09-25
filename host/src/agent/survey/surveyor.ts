import { log } from '../../log.ts'
import { AREA, EMPTY, TILE, type MapTile } from '../map.ts'
import { chunksIn, columnsCharted, missing, reachOf, sweep, type Footprint, type Leg } from './plan.ts'

/**
 * Flies a footprint until the whole of it has been charted.
 *
 * **It charts nothing itself.** `AgentMap` reads and reports every chunk the server sends, whether
 * or not a job asked for it, so the work here is to put the agent where the server will send the
 * ground that is still missing — and then to know when none of it is. What that buys is a survey
 * that cannot disagree with the map: the same reader fills both.
 *
 * **Told what it has charted rather than asking.** The tiles pass through here on their way out, so
 * a chunk counts when it has actually been read and sent, not when the agent happened to be near
 * it. A flight that ends with the count short is a flight that missed ground, which is exactly the
 * thing worth knowing.
 */

/** How often the flight is thought about again. Movement is the navigator's; this only steers. */
const TICK_MS = 500

/** Close enough to a leg to call it flown, in blocks. The point is the ground seen from it. */
const NEAR = 4

/** How far above the highest thing it can see a rising flight sits. */
const CLEARANCE = 4

/**
 * How long nothing may arrive before the piece is given up on.
 *
 * Long, because a legitimately slow stretch — a server chunk-starved, an agent walking because
 * flight was refused — must not read as a failure. What this catches is the flight that has stopped
 * getting anywhere at all, which otherwise sits at the same count until somebody notices.
 */
const STALL_MS = 120_000

/**
 * How often one chunk is flown to before the piece gives up on it.
 *
 * Per chunk rather than per pass over a list: a chunk that will not arrive is a chunk to stop
 * flying at, and the rest of the footprint should not be abandoned because of it.
 */
const TRIES = 2

export type SurveyOutcome = 'done' | 'failed' | 'stopped'

export interface SurveyHooks {
  /** Sends the agent to a column at a height. The navigator owns how it gets there. */
  steer(to: { x: number; y: number; z: number }): void
  /** Columns of this footprint charted so far, reported as it climbs. */
  progress(columns: number): void
  /** Says something an operator should know, in the agent's activity. */
  tell(text: string, bad?: boolean): void
  /** Where the agent is, or nothing while it is not in a world. */
  at(): { x: number; y: number; z: number } | undefined
}

export class Surveyor {
  /** Chunks of this footprint that have been read and sent. */
  private readonly charted = new Set<string>()

  /** The highest block seen in a chunk, for a flight that climbs. */
  private readonly tops = new Map<string, number>()

  private readonly wanted: ReadonlySet<string>
  private readonly legs: Leg[]

  private leg = 0

  /** How often each chunk has been flown to since the plan ran out. See {@link TRIES}. */
  private readonly tried = new Map<string, number>()

  /** The hole being flown to, so arriving at it can be counted against that chunk. */
  private hole: Leg | undefined

  /** Said once: a flight that missed nothing should not talk about going back. */
  private toldGoingBack = false

  private reported = -1
  private movedAt = Date.now()
  private stopped = false

  /** The last column steered to, so an unchanged heading is not re-sent every tick. */
  private heading = ''

  /** How far the agent is reliably sent chunks, in chunks. See {@link readAround}. */
  private readonly sees: number

  constructor(
    private readonly agentId: number,
    private readonly box: Footprint,
    /** The height the flight holds, or the lowest it may go when it climbs. */
    private readonly floor: number,
    private readonly rising: boolean,
    viewChunks: number,
    private readonly hooks: SurveyHooks,
    /**
     * The world these coordinates are in, as agents spell it.
     *
     * Empty from a backend that does not say, which is the old behaviour: count every tile and
     * trust the agent not to leave the world mid-survey.
     */
    private readonly dimension: string = '',
  ) {
    this.wanted = new Set(chunksIn(box))
    this.sees = Math.max(1, Math.floor(reachOf(viewChunks) / TILE))
    this.legs = sweep(box, reachOf(viewChunks))
  }

  /** Counted from what has been sent, which is why it is the number reported. */
  get columns(): number {
    return columnsCharted(this.box, this.charted)
  }

  stop(): void {
    this.stopped = true
  }

  /**
   * A tile this agent has just reported.
   *
   * Tiles for chunks outside the footprint arrive too — an agent sees a long way past the strip it
   * was given — and are kept for their height and counted for nothing. A survey's count is about
   * its own ground.
   */
  saw(tile: MapTile): void {
    // **The world it was read in, not only the coordinates.** The dimensions are separate places
    // sharing one grid, so an agent that goes through a portal would otherwise chart the nether
    // into an overworld survey, chunk for chunk, and call the piece finished.
    if (this.dimension && tile.dimension !== this.dimension) return

    const key = `${tile.x},${tile.z}`
    this.tops.set(key, topOf(tile))
    if (!this.wanted.has(key)) return

    this.charted.add(key)
    this.movedAt = Date.now()
  }

  async run(): Promise<SurveyOutcome> {
    if (!this.legs.length) return 'done'

    while (!this.stopped) {
      if (this.charted.size >= this.wanted.size) {
        this.report()
        return 'done'
      }

      const target = this.next()
      if (!target) {
        // The plan is flown and the holes have been visited as often as they are going to be.
        this.report()
        const short = this.wanted.size - this.charted.size
        log.warn(`Agent ${this.agentId} finished its flight with ${short} chunk(s) unread`)
        return 'failed'
      }

      const at = this.hooks.at()
      if (!at) return 'failed'

      if (near(at, target)) {
        this.arrive()
      } else {
        this.aim(target)
      }

      this.report()

      if (Date.now() - this.movedAt > STALL_MS) {
        this.hooks.tell('Nothing new has been charted for two minutes', true)
        return 'failed'
      }

      await pause(TICK_MS)
    }

    return 'stopped'
  }

  /**
   * Where to go next: the plan while it lasts, then whatever it missed.
   *
   * **A leg whose ground is already charted is skipped.** Segments overlap at their edges, an agent
   * sees past the strip it was given, and a survey flown twice for any reason starts with most of
   * it already read — flying to a line to be sent chunks that have already been sent is the one
   * thing this is meant to avoid.
   */
  private next(): Leg | undefined {
    while (this.leg < this.legs.length) {
      const leg = this.legs[this.leg]!
      if (!this.readAround(leg)) return leg
      this.leg++
    }

    // **Nearest from where the agent is now, every time.** A list sorted once and then followed is
    // a list sorted from somewhere the agent left minutes ago: it sends a flight across the whole
    // footprint and back for chunks that were next to each other.
    const at = this.hooks.at() ?? this.legs[0]!
    const holes = missing(this.box, this.charted, at).filter(
      (hole) => (this.tried.get(chunkKey(hole)) ?? 0) < TRIES,
    )

    if (!this.toldGoingBack && holes.length) {
      this.toldGoingBack = true
      log.info(`Agent ${this.agentId} is going back for ${holes.length} chunk(s) its flight missed`)
    }

    this.hole = holes[0]
    return this.hole
  }

  /**
   * Whether a leg would reveal nothing: everything it could be sent has already been read.
   *
   * Measured over what the agent would actually see from there — its view distance — rather than
   * the chunk it stands in, because that is the ground the leg exists to collect. A survey flown
   * twice, or one whose neighbour already covered the edge of this strip, skips those lines
   * entirely instead of flying them to be sent chunks it has.
   */
  private readAround(leg: Leg): boolean {
    const chunkX = Math.floor(leg.x / TILE)
    const chunkZ = Math.floor(leg.z / TILE)

    for (const key of this.wanted) {
      if (this.charted.has(key)) continue
      const [x, z] = key.split(',').map(Number)
      if (Math.max(Math.abs(x! - chunkX), Math.abs(z! - chunkZ)) <= this.sees) return false
    }
    return true
  }

  private arrive(): void {
    if (this.leg < this.legs.length) {
      this.leg++
      return
    }

    // Flown to and still not read: counted against this chunk rather than against the flight, so
    // one chunk that will not arrive does not end the rest of the piece.
    const hole = this.hole
    if (!hole) return
    const key = chunkKey(hole)
    this.tried.set(key, (this.tried.get(key) ?? 0) + 1)
  }

  private aim(target: Leg): void {
    const y = this.height(target)
    const key = `${target.x},${y},${target.z}`
    if (key === this.heading) return

    this.heading = key
    this.hooks.steer({ x: target.x, y, z: target.z })
  }

  /**
   * The height to fly at.
   *
   * Level: the one it was given, and nothing about the ground changes it.
   *
   * Rising: above the highest thing it can see between here and where it is going. The heights come
   * from the tiles this agent has already charted, so they cost nothing to read and arrive a view
   * distance ahead of the agent — which is to say the hill is known about well before it is
   * reached. Never below the floor: an operator who says 90 is saying the survey is worth nothing
   * lower than that.
   */
  private height(target: Leg): number {
    if (!this.rising) return this.floor

    const at = this.hooks.at()
    const from = at ?? { x: target.x, z: target.z }

    const west = Math.floor(Math.min(from.x, target.x) / TILE)
    const east = Math.floor(Math.max(from.x, target.x) / TILE)
    const north = Math.floor(Math.min(from.z, target.z) / TILE)
    const south = Math.floor(Math.max(from.z, target.z) / TILE)

    let top = this.floor - CLEARANCE
    for (let x = west; x <= east; x++) {
      for (let z = north; z <= south; z++) {
        const seen = this.tops.get(`${x},${z}`)
        if (seen !== undefined && seen > top) top = seen
      }
    }

    return Math.max(this.floor, top + CLEARANCE)
  }

  private report(): void {
    const columns = this.columns
    if (columns === this.reported) return
    this.reported = columns
    this.hooks.progress(columns)
  }
}

function chunkKey(leg: Leg): string {
  return `${Math.floor(leg.x / TILE)},${Math.floor(leg.z / TILE)}`
}

function near(at: { x: number; z: number }, leg: Leg): boolean {
  return Math.abs(at.x - leg.x) <= NEAR && Math.abs(at.z - leg.z) <= NEAR
}

/** The highest block a tile saw, or the bottom of the world where it saw nothing. */
export function topOf(tile: MapTile): number {
  const heights = Buffer.from(tile.heights, 'base64')
  let top = EMPTY

  for (let cell = 0; cell < AREA && cell * 2 + 1 < heights.length; cell++) {
    const height = heights.readInt16LE(cell * 2)
    if (height !== EMPTY && height > top) top = height
  }
  return top
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
