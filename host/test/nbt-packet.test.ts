import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { readNbtStringsProperly } from '../src/agent/nbt.ts'

const require = createRequire(import.meta.url)

/**
 * The path a chat component actually takes.
 *
 * prismarine-nbt compiles a standalone protocol *and* hands its types to node-minecraft-protocol,
 * which compiles a second copy into its own. Packet NBT - every chat component - goes through the
 * second. Correcting only the first passes a test and fixes nothing an agent receives, which is
 * exactly the mistake this exists to catch.
 */
describe('packet NBT strings', () => {
  it('reads an emoji written as surrogate halves', () => {
    readNbtStringsProperly()

    // Compiled after the correction, the way a client's protocol is.
    const { ProtoDefCompiler } = require('protodef').Compiler
    const nbt = require('prismarine-nbt')

    const compiler = new ProtoDefCompiler()
    nbt.addTypesToCompiler('big', compiler)
    const proto = compiler.compileProtoDefSync()

    // U+1F600 as the surrogates D83D DE00: six bytes where standard UTF-8 would use four.
    const body = Buffer.from([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80])
    const buffer = Buffer.concat([Buffer.from([0, body.length]), body])

    expect(proto.read(buffer, 0, 'shortString').value).toBe('😀')
  })

  it('leaves everything that was already correct alone', () => {
    readNbtStringsProperly()

    const { ProtoDefCompiler } = require('protodef').Compiler
    const nbt = require('prismarine-nbt')

    const compiler = new ProtoDefCompiler()
    nbt.addTypesToCompiler('big', compiler)
    const proto = compiler.compileProtoDefSync()

    for (const text of ['hello', 'こんにちは', '⟨|||⟩', 'Привет']) {
      const body = Buffer.from(text, 'utf8')
      const buffer = Buffer.concat([Buffer.from([0, body.length]), body])

      expect(proto.read(buffer, 0, 'shortString').value).toBe(text)
    }
  })
})
