import { createHash } from 'node:crypto'

import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

import { log } from '../log.ts'

/**
 * What an agent has seen from above, as the pixels of a Minecraft map.
 *
 * One pixel per block column at vanilla's zoom zero, so a chunk is exactly a 16x16 tile and the map
 * a browser draws lines up with the coordinates an operator reads off F3. Unlike the 3D view, this
 * runs whether or not anyone is looking: the point of the map is that it is already filled in by
 * the time somebody opens it.
 *
 * **Block names travel, not colours.** Which colour a block reads as is a question about textures,
 * and textures live in the frontend - the same atlas the 3D view is drawn from. Sending names keeps
 * the two views agreeing by construction, keeps the stored map re-colourable without re-walking the
 * world, and means the host needs no asset pipeline of its own.
 *
 * Tiles ride the ordinary JSON envelope rather than the viewer's binary socket. They are about a
 * kilobyte each and arrive a few times a second at most, which is nothing next to a chunk column of
 * block states - and the backend has to open this one to store it, which is the thing the binary
 * path is explicitly built not to do.
 */

/** Blocks per tile edge. Vanilla zoom zero: one pixel is one block column. */
export const TILE = 16

/** Pixels in a tile. */
export const AREA = TILE * TILE

/**
 * The height of a column with nothing worth drawing in it.
 *
 * Out of range of any world - the deepest a block can sit is -2048 - so it can never collide with a
 * real reading, and negative so that a receiver treating heights as unsigned gets an obviously wrong
 * answer rather than a plausible one.
 */
export const EMPTY = -32768

/** One chunk's worth of map, at the coordinates of the chunk rather than of the block. */
export interface MapTile {
  /**
   * Which world, without its `minecraft:` prefix.
   *
   * Part of what identifies a tile rather than a label on it. The dimensions are separate places
   * that share one coordinate system, so without this an agent stepping through a portal does not
   * add to the map - it overwrites it, chunk for chunk, with terrain from somewhere else.
   */
  dimension: string
  x: number
  z: number
  /** The distinct blocks on this tile's surface. At most {@link AREA}, one per column. */
  palette: string[]
  /** Base64 of {@link AREA} bytes, each an index into {@link palette}. Meaningless where the
   * matching height is {@link EMPTY}. */
  blocks: string
  /** Base64 of {@link AREA} signed 16-bit little-endian heights, or {@link EMPTY}. */
  heights: string
}

/** Just enough of a chunk column to read a surface off it. */
export interface Column {
  getBlockStateId(pos: { x: number; y: number; z: number }): number
}

/**
 * Blocks that are there but are not surface.
 *
 * Vanilla decides this with a map colour of `NONE`, which is a table a host has no access to. This
 * is the same set spelled out: the three kinds of air, and the four blocks that are deliberately
 * invisible to a player. A technical block left out of the list costs a single wrong pixel; leaving
 * out air would cost the whole map, which is why the airs are the part that matters.
 *
 * The frontend applies the real rule on top - a name it has no colour for is skipped the same way -
 * so this list being short is a performance measure rather than the only line of defence.
 */
const INVISIBLE: ReadonlySet<string> = new Set([
  'air',
  'cave_air',
  'void_air',
  'barrier',
  'light',
  'structure_void',
  'moving_piston',
])

/**
 * What a world is called when the bot has not been told yet.
 *
 * Every session starts here and leaves it on the first packet that names a world. Sending it would
 * file real terrain under a world that does not exist, so a tile read in this state is held back
 * rather than guessed at.
 */
export const UNKNOWN_DIMENSION = ''

/**
 * Which world this bot is standing in.
 *
 * **The level name, not the dimension type.** mineflayer reports the type in `bot.game.dimension`,
 * and says so in its own source: on a proxy or a modded server the level name may differ from the
 * type, and it needs the type for its codec lookup. That is the wrong identity for a map. A server
 * running Multiverse has any number of worlds that are all of type `overworld` - a survival world,
 * a creative one, a plot world - and filing them under the type puts every one of them on top of
 * the last, chunk for chunk.
 *
 * So the level name wins where the host could read one, and the type is the fallback for a version
 * that sends no name. Vanilla names its levels `minecraft:overworld` and the like, which strips to
 * exactly what the type would have given - so nothing already charted moves.
 */
export function worldOf(bot: { game?: { dimension?: string } }, level?: string): string {
  return strip(level) || strip(bot.game?.dimension) || UNKNOWN_DIMENSION
}

/** A resource id without its default namespace, which is noise in a world's name. */
function strip(name: string | undefined): string {
  return name?.replace(/^minecraft:/, '').trim() ?? ''
}

/**
 * The topmost visible block of every column in a chunk, as a tile.
 *
 * Scans each column downwards from the build limit and stops at the first thing a player could see,
 * which is what vanilla's map does and why water reads as a surface rather than as a hole down to
 * the riverbed. A column that is empty the whole way down - the void, or a chunk that arrived
 * without its sections - is left as {@link EMPTY} rather than guessed at.
 *
 * Pure, and takes the column and the name lookup rather than a bot, because everything that has
 * been wrong with a tile so far has been an off-by-one between block and chunk coordinates - which
 * is exactly what a fake column can pin down and a live server cannot.
 */
export function tileFrom(
  column: Column,
  at: { x: number; z: number; dimension: string },
  bounds: { minY: number; height: number },
  nameOf: (stateId: number) => string | undefined,
): MapTile {
  const palette: string[] = []
  const index = new Map<string, number>()
  const blocks = Buffer.alloc(AREA)
  const heights = Buffer.alloc(AREA * 2)

  const top = bounds.minY + bounds.height - 1
  const pos = { x: 0, y: 0, z: 0 }

  for (let z = 0; z < TILE; z++) {
    for (let x = 0; x < TILE; x++) {
      const cell = z * TILE + x
      pos.x = x
      pos.z = z

      let name: string | undefined
      let height = EMPTY
      for (let y = top; y >= bounds.minY; y--) {
        pos.y = y
        const stateId = column.getBlockStateId(pos)
        // Nothing is state zero in every version, and by far the commonest answer, so it is worth
        // refusing before the name lookup rather than after it.
        if (stateId === 0) continue
        const found = nameOf(stateId)
        if (!found || INVISIBLE.has(found)) continue
        name = found
        height = y
        break
      }

      heights.writeInt16LE(height, cell * 2)
      if (name === undefined) continue

      let slot = index.get(name)
      if (slot === undefined) {
        slot = palette.length
        palette.push(name)
        index.set(name, slot)
      }
      blocks[cell] = slot
    }
  }

  return {
    dimension: at.dimension,
    x: at.x,
    z: at.z,
    palette,
    blocks: blocks.toString('base64'),
    heights: heights.toString('base64'),
  }
}

/** Whether a tile has any surface at all, which an unloaded or void chunk does not. */
export function drawn(tile: MapTile): boolean {
  return tile.palette.length > 0
}

/**
 * How long a column waits after being touched before it is read.
 *
 * A chunk arrives as a stream of block changes rather than in one piece, and a player building
 * changes the same column many times a second. Reading once the changes have stopped turns both
 * into a single tile instead of dozens of nearly identical ones.
 */
const SETTLE = 1_500

/** How many tiles to read per pass. Each is a scan of 256 columns, so this is a frame budget. */
const PACE = 4

/** How often to look for work. */
const TICK = 250

/**
 * Follows one agent and reports the map under it.
 *
 * Runs for the whole session, not only while somebody is watching. What it costs is a scan of a
 * chunk when that chunk changes, which is the same order of work the agent already does to walk
 * around in it.
 */
export class AgentMap {
  /** Chunk coordinates waiting to be read, against the time they were last touched. */
  private readonly dirty = new Map<string, { x: number; z: number; at: number }>()

  /** The world this session is in, as of the last tile read. See {@link worldOf}. */
  private dimension = UNKNOWN_DIMENSION

  /** A digest of what was last sent for a chunk, so an unchanged one is read but not resent.
   * Hashed rather than kept whole: a tile is about 1.4 kB of base64, and an agent that walks for an
   * hour touches thousands of chunks. */
  private readonly sent = new Map<string, string>()

  private timer: ReturnType<typeof setInterval> | undefined

  private readonly onColumn = (point: { x: number; z: number }): void => {
    this.touch(Math.floor(point.x / TILE), Math.floor(point.z / TILE))
  }

  private readonly onBlock = (oldBlock: unknown, newBlock: { position?: { x: number; z: number } } | null): void => {
    const at = newBlock?.position
    if (!at) return
    this.touch(Math.floor(at.x / TILE), Math.floor(at.z / TILE))
  }

  constructor(
    private readonly agentId: number,
    private readonly bot: Bot,
    private readonly send: (tile: MapTile) => void,
    /** The level name the session last saw, read afresh each tile - see {@link worldOf}. */
    private readonly level: () => string | undefined = () => undefined,
  ) {}

  start(): void {
    if (this.timer) return

    this.bot.on('chunkColumnLoad', this.onColumn)
    this.bot.on('blockUpdate', this.onBlock)
    this.timer = setInterval(() => void this.drain(), TICK)

    log.debug(`Agent ${this.agentId} is mapping ${this.bot.version}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined

    this.bot.removeListener('chunkColumnLoad', this.onColumn)
    this.bot.removeListener('blockUpdate', this.onBlock)

    this.dirty.clear()
    // Kept, not cleared: the map is about the world, and the world did not change because this
    // agent stopped looking at it. Clearing would resend every tile on the next session.
  }

  /** Marks a chunk as worth reading again, and restarts its settling time. */
  private touch(x: number, z: number): void {
    this.dirty.set(`${x},${z}`, { x, z, at: Date.now() })
  }

  private async drain(): Promise<void> {
    const now = Date.now()
    const ready = [...this.dirty.entries()]
      .filter(([, entry]) => now - entry.at >= SETTLE)
      .slice(0, PACE)

    for (const [key, entry] of ready) {
      this.dirty.delete(key)
      try {
        await this.report(key, entry)
      } catch (failure) {
        // A chunk that went away mid-read, most likely. The next time it is touched it is read
        // again, so there is nothing to recover here.
        log.debug(`Agent ${this.agentId} could not map ${key}: ${String(failure)}`)
      }
    }
  }

  private async report(key: string, at: { x: number; z: number }): Promise<void> {
    const column = (await this.bot.world.getColumnAt(new Vec3(at.x * TILE, 0, at.z * TILE))) as Column | null
    if (!column) return

    // Typed without them, and absent before 1.18 - which is the pre-caves world, exactly the range
    // the fallbacks describe.
    const game = this.bot.game as unknown as { minY?: number; height?: number }
    const blocks = this.bot.registry.blocksByStateId

    // Read per tile rather than once per session: a dimension change is a new world under the
    // same agent, and a tile read after one and filed under the old name is terrain in the wrong
    // place. Cheap - it is a string off the bot.
    const world = worldOf(this.bot, this.level())
    // Held back rather than guessed at. A tile filed under a world that does not exist is terrain
    // nobody can find again, and the chunk stays dirty - the next pass reads it once the server has
    // said where we are.
    if (world === UNKNOWN_DIMENSION) {
      this.touch(at.x, at.z)
      return
    }
    if (world !== this.dimension) {
      // Nothing carried over. The digests say "this chunk already looks like this", which is a
      // statement about a world the agent has left, and would suppress the first look at the new
      // one wherever the coordinates happen to line up.
      this.sent.clear()
      this.dimension = world
    }

    const tile = tileFrom(
      column,
      { ...at, dimension: world },
      { minY: game.minY ?? 0, height: game.height ?? 256 },
      (stateId) => blocks[stateId]?.name,
    )
    if (!drawn(tile)) return

    // Sent once per distinct surface. A chunk is touched by every block change in it and by every
    // reload, and most of those leave what is visible from above exactly as it was.
    const shape = createHash('sha1')
      .update(tile.dimension)
      .update(tile.palette.join(','))
      .update(tile.blocks)
      .update(tile.heights)
      .digest('base64')
    if (this.sent.get(key) === shape) return
    this.sent.set(key, shape)

    this.send(tile)
  }
}
