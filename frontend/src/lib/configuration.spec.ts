import { describe, expect, it } from 'vitest'
import {
  CHAT_COMMANDS,
  COMMAND_NAMES,
  elevated,
  playersFrom,
  playersTo,
  settingsOf,
  KNOWN_KEYS,
} from './configuration'
import type { FleetAgent } from '../stores/agents'

/**
 * A player list has to survive a round trip through the one string a setting can hold, and that
 * string is stored by a backend that never reads it. So the parsing is the whole contract: anything
 * it lets through reaches a host, and anything it drops silently matches nobody.
 */
describe('reading a player list', () => {
  const chat = (...names: string[]) => names.map((name) => ({ name, commands: [...CHAT_COMMANDS] }))

  it('reads a list back exactly as it was written', () => {
    const written = [
      { name: 'Notch', commands: [...CHAT_COMMANDS] },
      { name: 'jeb_', commands: [...COMMAND_NAMES] },
      { name: 'Dinnerbone', commands: ['say', 'run'] },
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

  it('is not fooled by a colon where a name should be', () => {
    expect(playersFrom(':commands')).toEqual([])
    expect(playersFrom('[MEMBER]:commands')).toEqual([])
  })
})

/**
 * Which commands one player may use.
 *
 * The difference between making an agent talk and handing somebody its Minecraft account is one
 * entry in this list, so what it does when it is unsure has to be the safe answer every time.
 */
describe('granting commands one at a time', () => {
  it('writes a list joined by plus, because the entries are separated by commas', () => {
    expect(playersTo([{ name: 'Notch', commands: ['say', 'run'] }])).toBe('Notch:say+run')
  })

  it('reads a list back as the same commands', () => {
    expect(playersFrom('Notch:say+run')).toEqual([{ name: 'Notch', commands: ['say', 'run'] }])
  })

  it('drops a command named twice', () => {
    expect(playersFrom('Notch:run+run+say')).toEqual([{ name: 'Notch', commands: ['run', 'say'] }])
  })

  /** Granting nothing is a real thing to mean, and it must not read back as the old chat tier. */
  it('writes an empty grant as something, not as an empty suffix', () => {
    const written = playersTo([{ name: 'Notch', commands: [] }])

    expect(written).toBe('Notch:none')
    expect(playersFrom(written)).toEqual([{ name: 'Notch', commands: [] }])
  })

  /**
   * The tiers are what settings written before this held, so they are still read - and expanded,
   * because a set is the only thing the interface deals in now.
   */
  it('expands a stored tier into the commands it meant', () => {
    expect(playersFrom('Notch')).toEqual([{ name: 'Notch', commands: [...CHAT_COMMANDS] }])
    expect(playersFrom('Notch:chat')).toEqual([{ name: 'Notch', commands: [...CHAT_COMMANDS] }])
    expect(playersFrom('Notch:')).toEqual([{ name: 'Notch', commands: [...CHAT_COMMANDS] }])
    expect(playersFrom('Notch:commands')).toEqual([{ name: 'Notch', commands: [...COMMAND_NAMES] }])
  })

  /** The chat tier never reached the powerful three, and expanding it must not start. */
  it('expands the chat tier to the harmless commands only', () => {
    expect(CHAT_COMMANDS).toContain('say')
    expect(CHAT_COMMANDS).not.toContain('run')
    expect(CHAT_COMMANDS).not.toContain('disconnect')
    expect(CHAT_COMMANDS).not.toContain('reconnect')
  })

  /** Nothing writes a tier back, so what is stored says what is granted. */
  it('never writes a tier, even for a set that matches one exactly', () => {
    expect(playersTo([{ name: 'Notch', commands: [...COMMAND_NAMES] }])).not.toBe('Notch:commands')
    expect(playersTo([{ name: 'Notch', commands: [...CHAT_COMMANDS] }])).not.toBe('Notch')
  })

  /**
   * A word after the colon that is not a tier is a list of one, not a tier this build guessed at.
   * Falling back to the chat tier would grant seven commands to an entry that asked for something
   * else - and the host refuses a command it cannot name, so a list of nonsense grants nothing.
   */
  it('reads an unknown word as a list of one rather than as a tier', () => {
    expect(playersFrom('Notch:everything')).toEqual([{ name: 'Notch', commands: ['everything'] }])
    expect(playersFrom('Notch:COMMANDS')).toEqual([{ name: 'Notch', commands: ['COMMANDS'] }])
  })

  /**
   * A command written by a newer Osmium survives a round trip untouched. Dropping it would revoke a
   * grant every time an older interface saved this form.
   */
  it('carries a command it cannot name through unchanged', () => {
    expect(playersFrom(playersTo([{ name: 'Notch', commands: ['run', 'selfDestruct'] }]))).toEqual([
      { name: 'Notch', commands: ['run', 'selfDestruct'] },
    ])
  })

  it('knows which commands are the powerful ones', () => {
    expect(elevated('run')).toBe(true)
    expect(elevated('disconnect')).toBe(true)
    expect(elevated('reconnect')).toBe(true)
    expect(elevated('say')).toBe(false)
    expect(elevated('selfDestruct')).toBe(false)
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
