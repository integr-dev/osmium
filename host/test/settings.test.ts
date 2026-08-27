import mineflayer from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { playable, switched } from '../src/agent/bot.ts'

/**
 * The two settings that are read once, when a session opens.
 *
 * Both are total against whatever an operator typed, and both answer `undefined` for anything they
 * cannot use rather than throwing. That is the contract the caller depends on: a bad value falls
 * back to what an unconfigured agent does, and an agent stays connectable through a typo.
 */
describe('playable', () => {
  it('takes a version this build can speak', () => {
    expect(playable('1.21.4', 'test')).toBe('1.21.4')
    expect(playable(mineflayer.latestSupportedVersion, 'test')).toBe(mineflayer.latestSupportedVersion)
  })

  it('says nothing about nothing', () => {
    expect(playable(undefined, 'test')).toBeUndefined()
    expect(playable('', 'test')).toBeUndefined()
    expect(playable('   ', 'test')).toBeUndefined()
  })

  it('forgives the whitespace a copied version arrives with', () => {
    expect(playable('  1.21.4 ', 'test')).toBe('1.21.4')
  })

  /**
   * The point of the setting. A version node-minecraft-protocol has no definitions for throws inside
   * `createBot`, with no session behind it to report the failure - which is exactly the shape that
   * leaves an agent stuck in CONNECTING until the backend gives up on it.
   */
  it('refuses a version this build has no protocol for', () => {
    // Real Minecraft releases, and both absent from what this stack implements.
    expect(playable('1.12.1', 'test')).toBe('1.12.1')
    expect(playable('1.19.1', 'test')).toBeUndefined()
    expect(playable('1.14.2', 'test')).toBeUndefined()
  })

  it('refuses a version that is not one', () => {
    expect(playable('latest', 'test')).toBeUndefined()
    expect(playable('1.21.4; rm -rf', 'test')).toBeUndefined()
    expect(playable('9.9.9', 'test')).toBeUndefined()
  })
})

describe('switched', () => {
  it('reads both answers', () => {
    expect(switched('true', 'test')).toBe(true)
    expect(switched('false', 'test')).toBe(false)
  })

  /**
   * Unset is a third answer, not a `false`. It means the host decides - and collapsing it would turn
   * "work it out from the version" into "definitely not" for every agent nobody has configured.
   */
  it('keeps unset distinct from off', () => {
    expect(switched(undefined, 'test')).toBeUndefined()
    expect(switched('', 'test')).toBeUndefined()
  })

  it('takes however the interface wrote it', () => {
    expect(switched('TRUE', 'test')).toBe(true)
    expect(switched(' False ', 'test')).toBe(false)
  })

  it('will not guess at anything else', () => {
    // `1` and `yes` are plausible and neither is sent by anything, so reading them would be
    // inventing a second interface nobody maintains.
    for (const value of ['1', '0', 'yes', 'on', 'nope']) {
      expect(switched(value, 'test')).toBeUndefined()
    }
  })
})
