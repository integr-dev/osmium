import { describe, expect, it } from 'vitest'
import { playersFrom, playersTo, settingsOf, KNOWN_KEYS, TRUST } from './configuration'
import type { FleetAgent } from '../stores/agents'

/**
 * A player list has to survive a round trip through the one string a setting can hold, and that
 * string is stored by a backend that never reads it. So the parsing is the whole contract: anything
 * it lets through reaches a host, and anything it drops silently matches nobody.
 */
describe('reading a player list', () => {
  const chat = (...names: string[]) => names.map((name) => ({ name, trust: TRUST.chat }))

  it('reads a list back exactly as it was written', () => {
    const written = [
      { name: 'Notch', trust: TRUST.chat },
      { name: 'jeb_', trust: TRUST.commands },
    ]

    expect(playersFrom(playersTo(written))).toEqual(written)
  })

  it('takes however somebody pasted it', () => {
    for (const written of ['Notch,jeb_', 'Notch, jeb_', 'Notch jeb_', 'Notch\njeb_', 'Notch ,\n jeb_']) {
      expect(playersFrom(written)).toEqual(chat('Notch', 'jeb_'))
    }
  })

  /** A pasted column tends to carry a heading or a blank line, and losing the rest to save it is worse. */
  it('drops what could not be a player and keeps the rest', () => {
    expect(playersFrom('Notch, [MEMBER], jeb_')).toEqual(chat('Notch', 'jeb_'))
    expect(playersFrom('ThisNameIsFarTooLongToBeReal, jeb_')).toEqual(chat('jeb_'))
    expect(playersFrom('ʙʟᴏᴏᴍ, Notch')).toEqual(chat('Notch'))
    expect(playersFrom('a-b, c.d, Notch')).toEqual(chat('Notch'))
  })

  /** Minecraft compares names case-insensitively, so two spellings are one player. */
  it('keeps one entry per player, in the spelling that was typed', () => {
    expect(playersFrom('Notch, NOTCH, notch')).toEqual(chat('Notch'))
  })

  it('says nothing about nothing', () => {
    expect(playersFrom(undefined)).toEqual([])
    expect(playersFrom('')).toEqual([])
    expect(playersFrom('   ')).toEqual([])
    expect(playersFrom(',,,')).toEqual([])
  })

  /** Empty is what `saveSettings` strips as "never set", which is how a list is cleared. */
  it('writes an empty list as an empty string', () => {
    expect(playersTo([])).toBe('')
  })
})

/**
 * The tier is the whole difference between making an agent talk and handing somebody its Minecraft
 * account, so what it does when it is unsure has to be the safe answer every time.
 */
describe('how far a player is trusted', () => {
  it('writes the tier only when it is the elevated one', () => {
    expect(playersTo([{ name: 'Notch', trust: TRUST.chat }])).toBe('Notch')
    expect(playersTo([{ name: 'Notch', trust: TRUST.commands }])).toBe('Notch:commands')
  })

  /** A plain list of names is what the setting held before tiers existed, and it still reads. */
  it('reads a bare name as chat', () => {
    expect(playersFrom('Notch')).toEqual([{ name: 'Notch', trust: TRUST.chat }])
  })

  it('reads the elevated tier when it is written', () => {
    expect(playersFrom('Notch:commands')).toEqual([{ name: 'Notch', trust: TRUST.commands }])
  })

  /** A tier from a newer Osmium must not quietly grant more than this build understands. */
  it('falls back to chat for a tier it does not know', () => {
    expect(playersFrom('Notch:everything')).toEqual([{ name: 'Notch', trust: TRUST.chat }])
    expect(playersFrom('Notch:')).toEqual([{ name: 'Notch', trust: TRUST.chat }])
    expect(playersFrom('Notch:COMMANDS')).toEqual([{ name: 'Notch', trust: TRUST.chat }])
  })

  it('is not fooled by a colon where a name should be', () => {
    expect(playersFrom(':commands')).toEqual([])
    expect(playersFrom('[MEMBER]:commands')).toEqual([])
  })
})

describe('the settings a form binds to', () => {
  it('holds every known key, empty where nothing is set', () => {
    const seeded = settingsOf(undefined)

    for (const key of KNOWN_KEYS) expect(seeded[key]).toBe('')
  })

  /**
   * A key stored but not declared here belongs to a newer Osmium, and dropping it would quietly
   * clear a setting this build cannot show.
   */
  it('keeps a setting it does not know about', () => {
    const agent = { settings: { 'chat.sender': '^x', 'from.the.future': 'keep me' } } as unknown as FleetAgent

    expect(settingsOf(agent)['from.the.future']).toBe('keep me')
    expect(settingsOf(agent)['chat.sender']).toBe('^x')
  })
})
