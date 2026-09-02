import { gzipSync } from 'node:zlib'

import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

import { log } from '../log.ts'

/**
 * The world an agent can see, streamed to a browser that renders it.
 *
 * The renderer on the other end is prismarine-viewer's, unmodified. What travels between them is
 * its `WorldView` event vocabulary - `loadChunk`, `blockUpdate`, `entity` and the rest - because
 * that is the contract its `Viewer.listen` already speaks. Upstream's own `WorldView` is ported
 * here rather than imported: it is a hundred lines of JavaScript, and depending on the package for
 * them would pull three.js and 310 MB of prebuilt browser assets into a host that renders nothing.
 *
 * The port is not faithful in two places, both of which upstream can afford and a host over a wide
 * area network cannot. Frames are gzipped, because a chunk column is JSON and compresses about
 * fifteen times. And moving entities are coalesced onto a tick rather than forwarded per movement -
 * see {@link COALESCE}.
 */

/** What the renderer understands. Names are upstream's; changing one silently stops that update. */
export type ViewerEvent =
  | { name: 'loadChunk'; data: { x: number; z: number; chunk: string } }
  | { name: 'unloadChunk'; data: { x: number; z: number } }
  | { name: 'blockUpdate'; data: { pos: Vec3Like; stateId: number } }
  | { name: 'entity'; data: EntityUpdate }
  | { name: 'position'; data: { pos: Vec3Like; yaw: number; pitch: number } }
  /** Always first, and sent again on every session: the renderer cannot place a single block
   * without knowing which version's block states it is reading.
   *
   * Carries the world's vertical bounds with it. They are not the same in every dimension, and the
   * renderer assumes the pre-1.18 range of 0 to 256 - so without being told, everything below bedrock
   * level and above the old build limit is never drawn. */
  | { name: 'version'; data: { version: string; minY: number; height: number } }

interface Vec3Like {
  x: number
  y: number
  z: number
}

interface EntityUpdate {
  id: number
  name?: string
  username?: string
  pos?: Vec3Like
  width?: number
  height?: number
  pitch?: number
  yaw?: number
  delete?: true
}

/** Frame layout version, so a browser and a host that disagree say so rather than misread. */
export const FRAME_VERSION = 1

const FLAG_GZIP = 0x01

/** Below this a frame is sent as it is: gzip costs more than it saves on a few hundred bytes. */
export const GZIP_THRESHOLD = 4_096

/**
 * How long updates are gathered before being sent.
 *
 * The cost of this stream is not chunks, which arrive in bursts and then stop - it is entities.
 * `entityMoved` fires per entity per tick, so a busy server offers two thousand messages a second,
 * of which all but the last per entity are already stale on arrival. A tenth of a second is below
 * what anyone perceives on a moving figure and cuts that to the number of entities in view.
 */
export const COALESCE = 100

/**
 * Drops updates that a later one in the same batch already supersedes.
 *
 * Last-wins per subject, in place: the surviving update keeps the position the newest one held, so
 * an ordering that matters is preserved. A chunk that loads and unloads within one batch is
 * unloaded and never drawn; one that unloads and reloads is drawn once, which is the same picture
 * either way.
 *
 * Only updates that *replace* state are keyed. There is no such thing as a superseded block break.
 */
export function coalesce(events: ViewerEvent[]): ViewerEvent[] {
  const lastAt = new Map<string, number>()
  events.forEach((event, index) => lastAt.set(subject(event), index))

  return events
    .filter((event, index) => lastAt.get(subject(event)) === index)
    .map((event) => (event.name === 'entity' ? { ...event, data: entityIn(events, event.data.id) } : event))
}

/**
 * Folds every update for one entity into the one that survives.
 *
 * Entities are the exception to last-wins, because their updates are not interchangeable: a spawn
 * carries the name and the size, and every movement after it carries only a position. Dropping the
 * earlier one loses the only statement of how big the thing is, and the renderer builds its mesh
 * from undefined - which reaches the screen as `computeBoundingSphere(): Computed radius is NaN`
 * and an entity that is never drawn again.
 *
 * A removal is not merged into: an entity that left is gone, and the fields it had on the way out
 * are not something the renderer should still be told about.
 */
function entityIn(events: ViewerEvent[], id: number): EntityUpdate {
  const updates = events.filter((event) => event.name === 'entity' && event.data.id === id)
  const last = updates.at(-1)
  if (last?.name === 'entity' && last.data.delete) return last.data

  return updates.reduce<EntityUpdate>(
    (merged, event) => (event.name === 'entity' ? { ...merged, ...event.data } : merged),
    { id },
  )
}

/**
 * What an update is *about*, for coalescing.
 *
 * Chunk loads and unloads share a key deliberately - they are two answers to the same question,
 * "what is at this column", and only the last one is true.
 */
function subject(event: ViewerEvent): string {
  switch (event.name) {
    case 'loadChunk':
    case 'unloadChunk':
      return `chunk:${event.data.x},${event.data.z}`
    case 'blockUpdate':
      return `block:${event.data.pos.x},${event.data.pos.y},${event.data.pos.z}`
    case 'entity':
      return `entity:${event.data.id}`
    case 'position':
      return 'position'
    case 'version':
      return 'version'
  }
}

/**
 * Wraps a batch for the wire.
 *
 * A binary frame, so it needs no escaping and rides the same socket as the JSON protocol without
 * being confused for it - `ws` reports which of the two a frame was. The header names the agent,
 * because one socket carries every agent on the host and the browser subscribed to one.
 *
 * ```
 * 0      u8   frame version
 * 1      u8   flags (bit 0: body is gzipped)
 * 2..5   u32  agent id, big endian
 * 6..    body: UTF-8 JSON, an array of { name, data }
 * ```
 */
export function frame(agentId: number, events: ViewerEvent[]): Buffer {
  const json = Buffer.from(JSON.stringify(events), 'utf8')
  const compress = json.length >= GZIP_THRESHOLD
  const body = compress ? gzipSync(json) : json

  const header = Buffer.alloc(6)
  header.writeUInt8(FRAME_VERSION, 0)
  header.writeUInt8(compress ? FLAG_GZIP : 0, 1)
  header.writeUInt32BE(agentId, 2)

  return Buffer.concat([header, body])
}

/** Walks a square outwards from the middle, so what is nearest the agent is drawn first. */
export function spiral(radius: number): Array<{ x: number; z: number }> {
  const positions: Array<{ x: number; z: number }> = []
  let x = 0
  let z = 0
  let dx = 0
  let dz = -1
  const side = radius * 2

  for (let step = 0; step < side * side; step++) {
    if (-radius < x && x <= radius && -radius < z && z <= radius) positions.push({ x, z })
    if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
      const swap = dx
      dx = -dz
      dz = swap
    }
    x += dx
    z += dz
  }

  return positions
}

export function chunkPos(pos: Vec3Like): { x: number; z: number } {
  return { x: Math.floor(pos.x / 16), z: Math.floor(pos.z / 16) }
}

/**
 * Whether a column is in view.
 *
 * Asymmetric on purpose, and this is the whole of it: {@link spiral} walks the offsets
 * `-radius < d <= radius`, so the far edge it produces is `+radius`. A symmetric `|d| < radius`
 * agrees on every column except that edge, which it generates and then refuses to load - two whole
 * strips of the view, missing, on every fill. The bounds have to be the same bounds.
 */
export function within(centre: { x: number; z: number }, at: { x: number; z: number }, radius: number): boolean {
  const dx = at.x - centre.x
  const dz = at.z - centre.z
  return -radius < dx && dx <= radius && -radius < dz && dz <= radius
}

/** How many chunks either side of the agent are streamed. Six is upstream's default. */
const VIEW_DISTANCE = 6

/**
 * How long to wait between columns while filling the view.
 *
 * Upstream loads its spiral as fast as the world can hand columns over, which is right when the
 * renderer is in the same process. Here every column is a frame crossing two sockets, and a full
 * view is a hundred and forty-four of them: sent back to back they arrive as several megabytes in a
 * few milliseconds, which overruns the relay's write buffer and takes the watcher's socket down
 * with it - as an unexplained 1006, because nothing gets the chance to send a close frame.
 *
 * Pacing them costs about two seconds to draw a world that then stays drawn, and the columns arrive
 * nearest-first, so what the operator is looking at is there almost immediately.
 */
const FILL_PACE = 15

/**
 * How often the view is reconciled against what the agent can actually see.
 *
 * Derived rather than event-driven, for the same reason the backend sweeps for agents to rejoin: a
 * column can be missed two ways and neither leaves anything to hook. A chunk that arrives before
 * the position update that follows a teleport is judged against the old centre and refused; a
 * column the server has not streamed yet is skipped by the fill walking past it. Both are gaps that
 * no later event mentions, and a sweep closes them without having to enumerate them.
 *
 * Nearly free when there is nothing to do - a pass over a full view of already-loaded columns is a
 * hundred and forty-four set lookups.
 */
const RECONCILE = 3_000

function pause(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis))
}

/**
 * One agent's world, followed for as long as somebody is watching it.
 *
 * Started only on demand. Following an agent means listening to every block change and every entity
 * movement it can see, which is not something to do for a screen nobody has open.
 */
export class AgentViewer {
  private readonly loaded = new Set<string>()
  private pending: ViewerEvent[] = []
  private flusher: NodeJS.Timeout | undefined
  private sweeper: NodeJS.Timeout | undefined
  /** One fill at a time: the sweep and a chunk boundary can ask for one at the same moment. */
  private filling = false
  private centre: { x: number; z: number }
  private stopped = false

  private readonly onMove = () => this.moved()
  private readonly onChunk = (pos: Vec3Like) => void this.load(chunkPos(pos))
  private readonly onBlock = (before: MineflayerBlock | null, after: MineflayerBlock | null) => this.block(before, after)
  private readonly onSpawn = (entity: MineflayerEntity) => this.spawned(entity)
  private readonly onEntityMove = (entity: MineflayerEntity) => this.entityMoved(entity)
  private readonly onGone = (entity: MineflayerEntity) => this.gone(entity)

  constructor(
    private readonly agentId: number,
    private readonly bot: Bot,
    private readonly send: (frame: Buffer) => void,
  ) {
    this.centre = chunkPos(bot.entity.position)
  }

  /** The version the renderer has to be told before anything else means anything. */
  get version(): string {
    return this.bot.version
  }

  start(): void {
    this.bot.on('move', this.onMove)
    this.bot.on('chunkColumnLoad', this.onChunk)
    this.bot.on('blockUpdate', this.onBlock)
    this.bot.on('entitySpawn', this.onSpawn)
    this.bot.on('entityMoved', this.onEntityMove)
    this.bot.on('entityGone', this.onGone)

    this.flusher = setInterval(() => this.flush(), COALESCE)
    this.sweeper = setInterval(() => void this.fillNew(), RECONCILE)

    // First, and before anything that depends on it: the renderer reads block state ids against a
    // version, so a chunk arriving ahead of this one would be drawn against whatever it assumed.
    // The bounds come from the join packet; the fallbacks are the range every world had before
    // 1.18, which is what a server that does not state them is.
    const game = this.bot.game as { minY?: number; height?: number } | undefined
    this.emit({
      name: 'version',
      data: { version: this.bot.version, minY: game?.minY ?? 0, height: game?.height ?? 256 },
    })

    // Whoever just opened the screen has an empty scene, so everything already in view is said
    // again rather than waited for.
    for (const entity of Object.values(this.bot.entities ?? {})) {
      if (entity && entity !== this.bot.entity) this.spawned(entity)
    }
    this.position()
    void this.fill()

    log.debug(`Agent ${this.agentId} is being watched, streaming ${VIEW_DISTANCE} chunks of ${this.bot.version}`)
  }

  stop(): void {
    this.stopped = true
    this.bot.removeListener('move', this.onMove)
    this.bot.removeListener('chunkColumnLoad', this.onChunk)
    this.bot.removeListener('blockUpdate', this.onBlock)
    this.bot.removeListener('entitySpawn', this.onSpawn)
    this.bot.removeListener('entityMoved', this.onEntityMove)
    this.bot.removeListener('entityGone', this.onGone)

    clearInterval(this.flusher)
    clearInterval(this.sweeper)
    this.flusher = undefined
    this.sweeper = undefined
    this.filling = false
    this.pending = []
    this.loaded.clear()

    log.debug(`Agent ${this.agentId} is no longer being watched`)
  }

  private emit(event: ViewerEvent): void {
    if (this.stopped) return
    this.pending.push(event)

    // A column dwarfs everything else here, so it goes at once rather than waiting for the tick and
    // riding out with however many others arrived alongside it. That keeps one frame to about one
    // column, which is what lets the backend put a fixed ceiling on a frame at all - and it makes
    // the world appear a column at a time instead of in tenth-of-a-second clumps.
    if (event.name === 'loadChunk') this.flush()
  }

  private flush(): void {
    if (this.pending.length === 0) return
    const batch = coalesce(this.pending)
    this.pending = []
    this.send(frame(this.agentId, batch))
  }

  /** Sends everything in view, nearest first, one column at a time so a big load does not block. */
  private async fill(): Promise<void> {
    for (const offset of spiral(VIEW_DISTANCE)) {
      if (this.stopped) return
      await this.load({ x: this.centre.x + offset.x, z: this.centre.z + offset.z })
      await pause(FILL_PACE)
    }
  }

  private async load(at: { x: number; z: number }): Promise<void> {
    if (this.stopped) return
    if (!within(this.centre, at, VIEW_DISTANCE)) return

    const key = `${at.x},${at.z}`
    const column = await this.bot.world.getColumnAt(new Vec3(at.x * 16, 0, at.z * 16))
    if (!column) return

    this.loaded.add(key)
    // `toJson` is what the renderer's `Chunk.fromJson` expects, so the column is not re-encoded at
    // either end - it is the wire format, and the only reason a frame is ever big enough to gzip.
    this.emit({ name: 'loadChunk', data: { x: at.x * 16, z: at.z * 16, chunk: column.toJson() } })
  }

  private moved(): void {
    this.position()

    const now = chunkPos(this.bot.entity.position)
    if (now.x === this.centre.x && now.z === this.centre.z) return
    this.centre = now

    for (const key of [...this.loaded]) {
      const [x, z] = key.split(',').map(Number)
      if (x === undefined || z === undefined) continue
      if (within(now, { x, z }, VIEW_DISTANCE)) continue
      this.loaded.delete(key)
      this.emit({ name: 'unloadChunk', data: { x: x * 16, z: z * 16 } })
    }

    void this.fillNew()
  }

  /**
   * Sends whatever is in view and has not been sent, and nothing else.
   *
   * Guarded rather than queued: a second request while one is running would walk the same spiral
   * against the same set and send the same columns twice. Whatever the running pass misses is
   * picked up by the next sweep, which is the point of having one.
   */
  private async fillNew(): Promise<void> {
    if (this.filling || this.stopped) return
    this.filling = true

    try {
      for (const offset of spiral(VIEW_DISTANCE)) {
        if (this.stopped) return
        const at = { x: this.centre.x + offset.x, z: this.centre.z + offset.z }
        if (this.loaded.has(`${at.x},${at.z}`)) continue
        await this.load(at)
        await pause(FILL_PACE)
      }
    } finally {
      this.filling = false
    }
  }

  private position(): void {
    const entity = this.bot.entity
    if (!entity) return
    this.emit({
      name: 'position',
      data: {
        pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        yaw: entity.yaw,
        pitch: entity.pitch,
      },
    })
  }

  private block(before: MineflayerBlock | null, after: MineflayerBlock | null): void {
    if (!before || !after) return
    const stateId = after.stateId ?? ((after.type << 4) | 0)
    this.emit({
      name: 'blockUpdate',
      data: { pos: { x: before.position.x, y: before.position.y, z: before.position.z }, stateId },
    })
  }

  private spawned(entity: MineflayerEntity): void {
    if (entity === this.bot.entity) return
    this.emit({
      name: 'entity',
      data: {
        id: entity.id,
        ...(entity.name !== undefined ? { name: entity.name } : {}),
        ...(entity.username !== undefined ? { username: entity.username } : {}),
        ...(entity.width !== undefined ? { width: entity.width } : {}),
        ...(entity.height !== undefined ? { height: entity.height } : {}),
        pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      },
    })
  }

  private entityMoved(entity: MineflayerEntity): void {
    if (entity === this.bot.entity) return
    this.emit({
      name: 'entity',
      data: {
        id: entity.id,
        pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        pitch: entity.pitch,
        yaw: entity.yaw,
      },
    })
  }

  private gone(entity: MineflayerEntity): void {
    if (entity === this.bot.entity) return
    this.emit({ name: 'entity', data: { id: entity.id, delete: true } })
  }
}

/** Only the parts of mineflayer's block and entity this file reads. */
interface MineflayerBlock {
  position: Vec3Like
  stateId?: number
  type: number
}

interface MineflayerEntity {
  id: number
  name?: string
  username?: string
  position: Vec3Like
  width?: number
  height?: number
  yaw: number
  pitch: number
}
