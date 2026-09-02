import { describe, expect, it } from 'vitest'

import type { Bot } from 'mineflayer'

import { healthKey, healthOf } from '../src/agent/bot.ts'

/**
 * Reading somebody else's health off their entity metadata.
 *
 * The whole feature rests on one assumption: that `minecraft-data` names the metadata key, so the
 * index never has to be written down here. If that stops being true the number does not disappear —
 * it becomes whatever field has moved into slot nine, which is a wrong reading that looks entirely
 * plausible. That is what the first test is for.
 */

/** Enough of a bot to carry a registry. */
function botOn(version: string): Bot {
  return { registry: require('minecraft-data')(version) } as unknown as Bot
}

describe('healthKey', () => {
  it('finds the key by name on every version the fleet runs', () => {
    for (const version of ['1.20.4', '1.21.4', '1.21.9']) {
      expect(healthKey(botOn(version)), version).toBeTypeOf('number')
    }
  })

  it('has no answer for a registry that names no keys', () => {
    // A modded or very old registry. Absent beats a guess: an index picked here would read some
    // other field as hit points and look completely ordinary doing it.
    expect(healthKey({ registry: { entitiesByName: {} } } as unknown as Bot)).toBeUndefined()
  })
})

describe('healthOf', () => {
  it('reads the value at the key it was given', () => {
    expect(healthOf({ metadata: [, , , , , , , , , 18.5] }, 9)).toEqual({ health: 18.5 })
  })

  it('keeps half a heart and drops the noise below it', () => {
    expect(healthOf({ metadata: [19.900001] }, 0)).toEqual({ health: 19.9 })
  })

  it('says nothing when the key is unknown', () => {
    expect(healthOf({ metadata: [20] }, undefined)).toEqual({})
  })

  it('says nothing for a player whose metadata has not arrived', () => {
    // The moment between somebody coming into view and their first metadata packet. Absent, on the
    // same terms as ping and gamemode: the server has not said.
    expect(healthOf({}, 9)).toEqual({})
    expect(healthOf({ metadata: [] }, 9)).toEqual({})
  })

  it('refuses anything that is not a usable reading', () => {
    expect(healthOf({ metadata: ['20'] }, 0)).toEqual({})
    expect(healthOf({ metadata: [-1] }, 0)).toEqual({})
    expect(healthOf({ metadata: [Number.NaN] }, 0)).toEqual({})
  })

  it('keeps zero, which is a dead player rather than a missing one', () => {
    expect(healthOf({ metadata: [0] }, 0)).toEqual({ health: 0 })
  })
})
