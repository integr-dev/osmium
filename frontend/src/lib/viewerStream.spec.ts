import { describe, expect, it } from 'vitest'

import { Emitter, FRAME_VERSION, FrameError, readFrame, type ViewerEvent } from './viewerStream'

/** The mirror of `CompressionStream`, so the fixture is compressed by what the reader inflates. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const compressed = source.pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(compressed).arrayBuffer())
}

/** Builds a frame exactly the way the host's `frame()` does, so the two stay in step. */
async function frame(agentId: number, events: ViewerEvent[], { compress = false } = {}): Promise<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(events))
  const body = compress ? await gzip(json) : json

  const buffer = new ArrayBuffer(6 + body.length)
  const header = new DataView(buffer)
  header.setUint8(0, FRAME_VERSION)
  header.setUint8(1, compress ? 0x01 : 0)
  header.setUint32(2, agentId)
  new Uint8Array(buffer).set(body, 6)
  return buffer
}

const events: ViewerEvent[] = [{ name: 'blockUpdate', data: { pos: { x: 1, y: 2, z: 3 }, stateId: 9 } }]

describe('readFrame', () => {
  it('reads an uncompressed frame', async () => {
    expect(await readFrame(await frame(42, events))).toEqual({ agentId: 42, events })
  })

  it('reads a gzipped frame', async () => {
    expect(await readFrame(await frame(42, events, { compress: true }))).toEqual({ agentId: 42, events })
  })

  it('reads an agent id past the signed range, which a raw getInt32 would report negative', async () => {
    const read = await readFrame(await frame(4_000_000_000, events))
    expect(read.agentId).toBe(4_000_000_000)
  })

  it('refuses a frame shorter than its header rather than reading past the end', async () => {
    await expect(readFrame(new ArrayBuffer(3))).rejects.toBeInstanceOf(FrameError)
  })

  it('refuses a frame version it does not know', async () => {
    const buffer = await frame(1, events)
    new DataView(buffer).setUint8(0, FRAME_VERSION + 1)
    await expect(readFrame(buffer)).rejects.toBeInstanceOf(FrameError)
  })

  it('reads an empty batch, which is a frame like any other', async () => {
    expect(await readFrame(await frame(7, []))).toEqual({ agentId: 7, events: [] })
  })
})

describe('Emitter', () => {
  it('delivers to every listener on a name', () => {
    const emitter = new Emitter()
    const seen: unknown[] = []
    emitter.on('entity', (payload) => seen.push(payload))
    emitter.on('entity', (payload) => seen.push(payload))

    expect(emitter.emit('entity', 1)).toBe(true)
    expect(seen).toEqual([1, 1])
  })

  it('says so when nothing is listening', () => {
    expect(new Emitter().emit('entity', 1)).toBe(false)
  })

  it('keeps names apart', () => {
    const emitter = new Emitter()
    const seen: string[] = []
    emitter.on('entity', () => seen.push('entity'))
    emitter.emit('blockUpdate', {})

    expect(seen).toEqual([])
  })

  it('forgets everything on removeAllListeners, so a remount does not double-render', () => {
    const emitter = new Emitter()
    emitter.on('entity', () => expect.unreachable('listener survived removal'))
    emitter.removeAllListeners()

    expect(emitter.emit('entity', 1)).toBe(false)
  })
})
