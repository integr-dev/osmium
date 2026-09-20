import { log } from '../../log.ts'
import type { BlockPos } from '../../protocol/wire.ts'

/**
 * The blocks of one piece, as the backend packs them.
 *
 * Fetched over HTTP rather than sent down the socket: the socket is the control plane and sends on
 * it are serialised per host, so a segment of any size there would stall heartbeats, vitals and
 * every command for every agent on this machine. See §7.2 of the README.
 *
 * ```
 * "OSM1"                     magic and version
 * u16                        palette entries
 *   u16 length, UTF-8        each block state, `minecraft:oak_stairs[facing=east]`
 * i32 x3                     box minimum, world coordinates
 * u32 x3                     box size
 * u32                        block count
 *   u32 linear, u16 palette  each block, ascending
 * ```
 *
 * Big-endian throughout, and `linear = ((y * dz) + z) * dx + x` from the box minimum.
 */

export const MAGIC = 'OSM1'

export interface Segment {
  min: BlockPos
  size: { x: number; y: number; z: number }
  /** Block *states*, not block names: stairs without their facing are stairs pointing anywhere. */
  palette: string[]
  /**
   * Positions, ascending, as linear indices into the box.
   *
   * Two parallel typed arrays rather than an array of objects. A piece is millions of blocks, and
   * one object each is an allocation per block plus a pointer chase per lookup - where this is six
   * bytes each and a binary search over contiguous memory.
   *
   * Held as `Int32Array` and read back through `>>> 0`: a box may be large enough for an index past
   * 2^31, which arrives here negative and is the right unsigned number the moment it is asked for.
   */
  linear: Int32Array
  states: Uint16Array
}

/** How many blocks the piece asks for. */
export function blockCount(segment: Segment): number {
  return segment.linear.length
}

/** Where a world position lands in the box's order, or nothing when it is outside the box. */
export function linearOf(segment: Segment, at: BlockPos): number | undefined {
  const dx = at.x - segment.min.x
  const dy = at.y - segment.min.y
  const dz = at.z - segment.min.z

  if (dx < 0 || dy < 0 || dz < 0) return undefined
  if (dx >= segment.size.x || dy >= segment.size.y || dz >= segment.size.z) return undefined

  return (dy * segment.size.z + dz) * segment.size.x + dx
}

/** The world position of one linear index. */
export function positionOf(segment: Segment, linear: number): BlockPos {
  const { x: dx, z: dz } = segment.size
  const plane = dx * dz

  const y = Math.floor(linear / plane)
  const rest = linear - y * plane
  const z = Math.floor(rest / dx)
  const x = rest - z * dx

  return { x: segment.min.x + x, y: segment.min.y + y, z: segment.min.z + z }
}

/**
 * The state wanted at a world position, or nothing when the piece asks for nothing there.
 *
 * A binary search rather than a map. The indices arrive sorted, which is what makes the search
 * possible, and a `Map` over a few million numbers costs tens of bytes each against the six these
 * two arrays use - on the one structure a builder holds for the whole piece.
 */
export function stateAt(segment: Segment, at: BlockPos): string | undefined {
  const linear = linearOf(segment, at)
  if (linear === undefined) return undefined

  const index = indexOfLinear(segment, linear)
  return index === undefined ? undefined : segment.palette[segment.states[index]!]
}

/** Where a linear index sits in {@link Segment.linear}, or nothing when the piece skips it. */
export function indexOfLinear(segment: Segment, linear: number): number | undefined {
  let low = 0
  let high = segment.linear.length - 1

  while (low <= high) {
    const middle = (low + high) >>> 1
    const here = segment.linear[middle]! >>> 0
    if (here === linear) return middle
    if (here < linear) low = middle + 1
    else high = middle - 1
  }

  return undefined
}

/**
 * Reads one.
 *
 * Every length is checked against what is left rather than trusted, because the alternative to
 * refusing a truncated body is building most of a piece and stopping somewhere arbitrary.
 */
export function decodeSegment(bytes: Uint8Array): Segment {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0

  const need = (count: number, what: string): void => {
    if (at + count > bytes.byteLength) {
      throw new Error(`Segment ends inside its ${what}: wanted ${count} more bytes at ${at} of ${bytes.byteLength}`)
    }
  }

  need(4, 'magic')
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  if (magic !== MAGIC) throw new Error(`Not a segment: it starts '${magic}', not '${MAGIC}'`)
  at = 4

  need(2, 'palette length')
  const paletteSize = view.getUint16(at)
  at += 2

  const palette: string[] = []
  const decoder = new TextDecoder()
  for (let entry = 0; entry < paletteSize; entry += 1) {
    need(2, 'palette entry length')
    const length = view.getUint16(at)
    at += 2
    need(length, 'palette entry')
    palette.push(decoder.decode(bytes.subarray(at, at + length)))
    at += length
  }

  need(24, 'box')
  const min = { x: view.getInt32(at), y: view.getInt32(at + 4), z: view.getInt32(at + 8) }
  const size = { x: view.getUint32(at + 12), y: view.getUint32(at + 16), z: view.getUint32(at + 20) }
  at += 24

  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    throw new Error(`Segment box measures ${size.x}x${size.y}x${size.z}`)
  }

  need(4, 'block count')
  const count = view.getUint32(at)
  at += 4

  need(count * RECORD_BYTES, 'blocks')
  const linear = new Int32Array(count)
  const states = new Uint16Array(count)
  for (let index = 0; index < count; index += 1) {
    linear[index] = view.getInt32(at)
    const state = view.getUint16(at + 4)
    if (state >= paletteSize) {
      throw new Error(`Block ${index} names palette entry ${state} of ${paletteSize}`)
    }
    states[index] = state
    at += RECORD_BYTES
  }

  return { min, size, palette, linear, states }
}

/**
 * The piece is no longer this agent's to build.
 *
 * Its own type because it is the one fetch failure that is not a failure — see the 409 below.
 */
export class SegmentGone extends Error {
  constructor(jobId: number, segmentId: number, said: string) {
    super(`Segment ${segmentId} of job ${jobId} is not ours to build: ${said || 'no reason given'}`)
    this.name = 'SegmentGone'
  }
}

/**
 * Asks the backend for a piece's blocks.
 *
 * The ticket is a capability for exactly this segment, minted by the command that handed it over,
 * and it is never persisted: losing it means the assignment is gone too. The host's own enrolment
 * token must never appear here - this is a `GET`, and its headers end up in logs and proxies.
 */
export async function fetchSegment(
  base: string,
  jobId: number,
  segmentId: number,
  ticket: string,
): Promise<Segment> {
  const url = `${base}/api/hostlink/jobs/${jobId}/segments/${segmentId}`

  const response = await fetch(url, {
    headers: {
      'X-Osmium-Ticket': ticket,
      // The body is highly compressible - positions are monotonic - and the backend serves it as
      // sent otherwise.
      'Accept-Encoding': 'gzip',
    },
  })

  // Not ours to build any more: the job was paused, finished, or the piece was handed to
  // somebody else. Told apart from every other failure because it is not one - there is
  // nothing to retry and nothing to report, and saying `failed` here would turn "somebody
  // pressed pause" into a piece an operator has to come and look at.
  // The backend says which of the two it is - the job is finished, or the piece is not this
  // agent's - and they are not the same thing to whoever is reading the log.
  if (response.status === 409) throw new SegmentGone(jobId, segmentId, await said(response))

  if (!response.ok) {
    throw new Error(
      `The backend answered ${response.status} for segment ${segmentId} of job ${jobId}: ${await said(response)}`,
    )
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const segment = decodeSegment(bytes)
  log.debug(
    `Segment ${segmentId}: ${blockCount(segment)} blocks, ${segment.palette.length} materials, ${bytes.byteLength} bytes`,
  )

  return segment
}

/**
 * Where to fetch from, worked out from the socket this host already dials.
 *
 * One address rather than two settings. The blocks come from the same Osmium the commands do, so a
 * second URL would only ever be a way to point them at different ones by accident.
 */
export function httpBase(socketUrl: string): string {
  const url = new URL(socketUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = ''
  url.search = ''
  url.hash = ''

  return url.toString().replace(/\/$/, '')
}

/**
 * What the backend said about a refusal, as far as it can be read.
 *
 * Spring answers a `ResponseStatusException` with a JSON problem whose `message` is the reason,
 * and a proxy in front of it may answer with anything at all — so this reads what it can and is
 * never the thing that fails.
 */
async function said(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return ''

    const body = JSON.parse(text) as { message?: unknown; error?: unknown }
    if (typeof body.message === 'string') return body.message
    if (typeof body.error === 'string') return body.error
    return text.slice(0, 200)
  } catch {
    return ''
  }
}

const RECORD_BYTES = 6
