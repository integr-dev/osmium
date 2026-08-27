/**
 * Reading NBT strings the way Java writes them.
 *
 * **Upstream bug, corrected at the seam.** Chat components have travelled as NBT rather than JSON
 * since 1.20.3, and an NBT string is Java's *modified* UTF-8 - the format `DataOutput.writeUTF`
 * produces. It differs from the real thing in exactly two places:
 *
 * - a character outside the basic plane (any emoji) is written as its **two surrogate halves**,
 *   three bytes each, rather than as one four-byte sequence;
 * - a null character is written as `C0 80` rather than as a zero byte.
 *
 * prismarine-nbt decodes with `buffer.toString('utf8')`, and Node rejects encoded surrogates because
 * they are illegal in standard UTF-8 - one replacement character per byte. So every emoji became six
 * `�`, which is what a server's decorated nicknames arrived as: `⟨|||⟨������������������⟩|||⟩`.
 *
 * The loss happens while decoding, so nothing downstream can undo it. This replaces the reader
 * rather than forking the library - the function it installs is the same one, with the decoding
 * corrected.
 *
 * **Two places, because there are two protocols.** prismarine-nbt compiles a standalone one, used
 * for the compressed NBT that carries item data. But packet NBT - which is what a chat component is
 * - goes through `addTypesToCompiler`, which compiles the same types *into node-minecraft-protocol's
 * own protocol*, a different object built per client. Correcting only the standalone one fixes
 * `parseUncompressed` in a test and nothing an agent actually receives.
 *
 * `shortString` is only ever NBT: it comes from prismarine-nbt's schema, while the protocol's own
 * strings are a `pstring` counted by varint. So correcting it by name cannot reach anything else.
 *
 * Remove once prismarine-nbt reads modified UTF-8. See PrismarineJS/prismarine-nbt.
 */
import { createRequire } from 'node:module'

import { log } from '../log.ts'

/** What prismarine-nbt's compiled reader looks like. */
type Reader = (buffer: Buffer, offset: number) => { value: string; size: number }

interface Proto {
  readCtx?: Record<string, Reader | undefined>
}

let corrected = false

/**
 * Corrects NBT string decoding, once per process.
 *
 * Safe to call again, and safe to fail: a prismarine-nbt whose shape has moved leaves a warning
 * rather than stopping the host. Emoji in chat would then be mangled as before, which is worth a log
 * line and not worth refusing to play over.
 */
export function readNbtStringsProperly(): void {
  if (corrected) return
  corrected = true

  let protos: Record<string, Proto>

  try {
    // Reached through `require` because this goes inside a CommonJS module's compiled internals,
    // which is not something it publishes a typed entry point for. `createRequire` rather than a
    // bare `require`, which does not exist in the ES module this compiles to.
    protos = (createRequire(import.meta.url)('prismarine-nbt') as { protos: Record<string, Proto> }).protos
  } catch (err) {
    log.warn(`Could not reach prismarine-nbt to correct its string decoding: ${err}`)
    return
  }

  let patched = 0

  for (const proto of Object.values(protos)) patched += correct(proto) ? 1 : 0

  // The one that actually matters for chat: every protocol a client compiles from here on.
  patched += hookCompiler() ? 1 : 0

  if (patched) log.debug(`Reading NBT strings as modified UTF-8 (${patched} protocols corrected)`)
  else log.warn('Could not correct NBT string decoding; emoji in chat will be mangled')
}

/** Wraps one compiled protocol's NBT string reader. `false` when it has no such reader, which is
 * either a protocol without NBT in it or a prismarine-nbt whose shape has moved. */
function correct(proto: Proto): boolean {
  const original = proto.readCtx?.shortString
  if (!proto.readCtx || typeof original !== 'function') return false

  proto.readCtx.shortString = (buffer, offset) => {
    const read = original(buffer, offset)

    // Only when it went wrong. A string that decoded cleanly is already right, and re-reading every
    // tag name in every packet would cost more than it is worth.
    return read.value.includes('�') ? { ...read, value: reread(buffer, offset, read.size) } : read
  }

  return true
}

/**
 * Corrects every protocol compiled after this point.
 *
 * node-minecraft-protocol compiles its protocol lazily, per state and direction, the first time a
 * client needs one - so there is nothing to reach into until an agent connects, and by then the
 * packets have started. Wrapping the compiler catches all of them at the moment they are built,
 * which is why this has to run before the first bot rather than after.
 */
function hookCompiler(): boolean {
  try {
    const { Compiler } = createRequire(import.meta.url)('protodef') as {
      Compiler: { ProtoDefCompiler: { prototype: { compileProtoDefSync: () => Proto } } }
    }

    const compiler = Compiler.ProtoDefCompiler.prototype
    const original = compiler.compileProtoDefSync

    compiler.compileProtoDefSync = function compileProtoDefSync(this: unknown): Proto {
      const proto = original.call(this)
      correct(proto)

      return proto
    }

    return true
  } catch (err) {
    log.warn(`Could not correct NBT string decoding for the protocol: ${err}`)
    return false
  }
}

/**
 * Decodes the same bytes again, as modified UTF-8.
 *
 * The count is a `u16` in front of the text, so the whole read is recovered from the offset and the
 * size the original reported.
 */
function reread(buffer: Buffer, offset: number, size: number): string {
  const count = buffer.readUInt16BE(offset)
  const start = offset + 2

  return decode(buffer.subarray(start, start + Math.min(count, size)))
}

/**
 * Java's modified UTF-8.
 *
 * Written out rather than leaned on a library, because it is a small, fixed format and this is the
 * one place that needs it. Anything malformed becomes a replacement character, exactly as a standard
 * decoder would do - a server sending rubbish must not be able to throw here.
 */
function decode(bytes: Buffer): string {
  let out = ''

  for (let at = 0; at < bytes.length; ) {
    const first = bytes[at]!

    // Plain ASCII, which is the overwhelming majority of every string in the format.
    if (first < 0x80) {
      out += String.fromCharCode(first)
      at += 1
      continue
    }

    if ((first & 0xe0) === 0xc0 && at + 1 < bytes.length) {
      // Two bytes. `C0 80` is this format's null; it decodes to U+0000 like any other.
      out += String.fromCharCode(((first & 0x1f) << 6) | (bytes[at + 1]! & 0x3f))
      at += 2
      continue
    }

    if ((first & 0xf0) === 0xe0 && at + 2 < bytes.length) {
      // Three bytes. This is where a surrogate half lives, and writing it straight into a JavaScript
      // string is exactly right: strings are UTF-16, so the pair re-forms into the character on its
      // own.
      out += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[at + 1]! & 0x3f) << 6) | (bytes[at + 2]! & 0x3f))
      at += 3
      continue
    }

    out += '�'
    at += 1
  }

  return out
}
