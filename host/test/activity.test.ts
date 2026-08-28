import type { Bot } from 'mineflayer'
import { describe, expect, it } from 'vitest'

import { flatten, lasted, placeOf } from '../src/agent/bot.ts'
import type { Component } from '../src/agent/chat.ts'

/**
 * The sentences an operator reads in the activity feed.
 *
 * All three are formatting, which is exactly where a bug renders as a plausible wrong answer rather
 * than as an error: a death in the wrong dimension, a session that lasted "1 minutes", a kick
 * reason that came out as `[object Object]`.
 */
describe('flatten', () => {
  const node = (text: string, extra?: Component[]): Component => ({ text, ...(extra ? { extra } : {}) })

  it('reads a whole tree as one line', () => {
    // What a resolved death message looks like: the key has already become a sentence with the
    // names substituted into it, split across nodes because each was styled differently.
    const death = node('', [node('Mason_04'), node(' was slain by '), node('Zombie')])

    expect(flatten(death)).toBe('Mason_04 was slain by Zombie')
  })

  it('keeps nesting in reading order', () => {
    expect(flatten(node('a', [node('b', [node('c')]), node('d')]))).toBe('abcd')
  })

  it('says nothing about an empty tree', () => {
    expect(flatten(node(''))).toBe('')
  })
})

describe('placeOf', () => {
  const standing = (position: unknown, dimension?: string) =>
    ({ entity: position ? { position } : undefined, game: { dimension } }) as unknown as Bot

  it('rounds, because a feed is read rather than navigated by', () => {
    expect(placeOf(standing({ x: 128.4921, y: 71, z: -344.75 }, 'overworld'))).toBe(
      '128, 71, -345 in the overworld',
    )
  })

  /** `the_nether` would otherwise read as "in the the nether". */
  it('does not say "the" twice', () => {
    expect(placeOf(standing({ x: 0, y: 64, z: 0 }, 'the_nether'))).toBe('0, 64, 0 in the nether')
    expect(placeOf(standing({ x: 0, y: 64, z: 0 }, 'the_end'))).toBe('0, 64, 0 in the end')
  })

  it('drops the namespace a server may or may not send', () => {
    expect(placeOf(standing({ x: 1, y: 2, z: 3 }, 'minecraft:overworld'))).toBe('1, 2, 3 in the overworld')
  })

  it('gives coordinates alone rather than an empty dimension', () => {
    expect(placeOf(standing({ x: 1, y: 2, z: 3 }))).toBe('1, 2, 3')
  })

  /**
   * `login` arrives before the world does, so there is a real window where an agent is in the game
   * and has no entity. A caller says less rather than writing "at undefined".
   */
  it('says nothing when there is no entity yet', () => {
    expect(placeOf(standing(undefined, 'overworld'))).toBeUndefined()
  })
})

describe('lasted', () => {
  const ago = (seconds: number) => Date.now() - seconds * 1000

  it('counts seconds while there are few enough to matter', () => {
    expect(lasted(ago(3))).toBe('3 seconds')
    expect(lasted(ago(90))).toBe('90 seconds')
  })

  it('does not write "1 seconds"', () => {
    expect(lasted(ago(1))).toBe('1 second')
    // Nothing takes zero time, and "0 seconds" reads as a measurement that failed.
    expect(lasted(Date.now())).toBe('1 second')
  })

  it('moves up a unit rather than counting past two of the next one', () => {
    expect(lasted(ago(60 * 5))).toBe('5 minutes')
    expect(lasted(ago(60 * 119))).toBe('119 minutes')
    expect(lasted(ago(60 * 60 * 6))).toBe('6 hours')
  })
})
