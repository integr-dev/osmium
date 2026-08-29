/**
 * The wire between a host's world and prismarine-viewer's renderer.
 *
 * The renderer is upstream's, unmodified, and it consumes an event emitter - `loadChunk`,
 * `blockUpdate`, `entity` and the rest. Upstream fills that emitter from a socket.io connection
 * straight to the host. Osmium's hosts dial out and are never reachable, so the same events come
 * over the backend instead, as binary frames, and this turns them back into what the renderer
 * expects.
 *
 * Frames are laid out by the host's `viewer.ts`:
 *
 * ```
 * 0      u8   frame version
 * 1      u8   flags (bit 0: body is gzipped)
 * 2..5   u32  agent id, big endian
 * 6..    body: UTF-8 JSON, an array of { name, data }
 * ```
 */

/** What this build can read. A host sending anything else is newer than this page. */
export const FRAME_VERSION = 1

const HEADER = 6
const FLAG_GZIP = 0x01

export interface ViewerEvent {
  name: string
  data: unknown
}

/** Thrown for a frame this build cannot read, so the caller can say so rather than render nothing. */
export class FrameError extends Error {}

/**
 * Reads one frame.
 *
 * Async because the body may be gzipped and `DecompressionStream` is the browser's own - there is
 * no inflate library in this bundle, and adding one to read what the platform already reads would
 * be weight for nothing.
 */
export async function readFrame(buffer: ArrayBuffer): Promise<{ agentId: number; events: ViewerEvent[] }> {
  if (buffer.byteLength < HEADER) throw new FrameError('frame is shorter than its header')

  const header = new DataView(buffer, 0, HEADER)
  const version = header.getUint8(0)
  if (version !== FRAME_VERSION) throw new FrameError(`frame version ${version} is not ${FRAME_VERSION}`)

  const gzipped = (header.getUint8(1) & FLAG_GZIP) === FLAG_GZIP
  const agentId = header.getUint32(2)
  const body = buffer.slice(HEADER)

  const json = gzipped ? await inflate(body) : new TextDecoder().decode(body)
  return { agentId, events: JSON.parse(json) as ViewerEvent[] }
}

async function inflate(body: ArrayBuffer): Promise<string> {
  // Fed from a ReadableStream rather than `new Blob([body]).stream()`: the Blob method is the
  // shorter spelling but jsdom does not implement it, which would leave the one branch that
  // actually matters - a chunk column - untested.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(body))
      controller.close()
    },
  })

  // The cast is the DOM lib disagreeing with itself: DecompressionStream is typed as accepting
  // BufferSource while pipeThrough demands an exact Uint8Array pair. The values are the same bytes.
  const inflated = source.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  return new Response(inflated).text()
}

/**
 * The smallest thing `Viewer.listen` will accept.
 *
 * It wants an emitter, and Node's `events` is not something to bundle for six lines. `emit` is here
 * for the one thing the renderer sends back - a click it raycasts - which nothing reads yet: this
 * viewer is receive-only, and driving an agent from it would be its own permission node rather
 * than a wider reading of the one that opened this socket.
 */
export class Emitter {
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>()

  on(name: string, listener: (payload: unknown) => void): this {
    const existing = this.listeners.get(name)
    if (existing) existing.push(listener)
    else this.listeners.set(name, [listener])
    return this
  }

  emit(name: string, payload?: unknown): boolean {
    const listeners = this.listeners.get(name)
    if (!listeners?.length) return false
    for (const listener of listeners) listener(payload)
    return true
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}
