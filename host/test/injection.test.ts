import { describe, expect, it } from 'vitest'

import { commandIn, sayable } from '../src/agent/command.ts'
import { compile, SERVER, senderOf, spokenIn } from '../src/agent/sender.ts'

/**
 * Adversarial cases for the one untrusted input in this host.
 *
 * Written as an audit rather than as coverage: each of these is a way somebody standing on the
 * server might try to be read as somebody else, and the last block is the two ways they can succeed
 * that no parser can close.
 */
const AURA = compile('^\\s*(?:\\[[^\\]]*\\]\\s*)*([A-Za-z0-9_]{1,16})(?:\\s*\\[[^\\]]*\\])*\\s*»', 'aura')!
const DA = compile('^.+?\\s([A-Za-z0-9_]{1,16}):\\s', 'da')!

/** Everything an attacker controls is the message body. Everything deciding trust is the prefix. */
function asAura(who: string, said: string) {
  return ` [★1] [MEMBER] ${who} [tag] » ${said}`
}

function asDa(who: string, said: string) {
  return `[Member] ${who}: ${said}`
}

/** Eve is on the server and is on nobody's whitelist. `integr` is trusted for commands. */
describe('an untrusted player trying to be a trusted one', () => {
  it('cannot name somebody else by writing their name first', () => {
    for (const [pattern, line] of [
      [AURA, asAura('Eve', 'integr » !osm run /op Eve')],
      [DA, asDa('Eve', 'integr: !osm run /op Eve')],
    ] as const) {
      expect(senderOf(line, pattern)).toBe('Eve')
      expect(commandIn(spokenIn(line, pattern)!)).toBeUndefined()
    }
  })

  it('cannot move where the message starts by repeating the separator', () => {
    for (const [pattern, line] of [
      [AURA, asAura('Eve', '» !osm run /op Eve')],
      [DA, asDa('Eve', ': !osm run /op Eve')],
    ] as const) {
      expect(senderOf(line, pattern)).toBe('Eve')
      expect(commandIn(spokenIn(line, pattern)!)).toBeUndefined()
    }
  })

  /** The command is still parsed — and then refused, because Eve is not trusted. */
  it('is read as themselves when they issue a command plainly', () => {
    const line = asDa('Eve', '!osm run /op Eve')

    expect(senderOf(line, DA)).toBe('Eve')
    expect(commandIn(spokenIn(line, DA)!)).toEqual({ account: undefined, name: 'run', args: ['/op', 'Eve'] })
  })

  it('cannot forge a whole prefix inside a message', () => {
    const line = asDa('Eve', '[Member] integr: !osm run /op Eve')

    expect(senderOf(line, DA)).toBe('Eve')
    expect(commandIn(spokenIn(line, DA)!)).toBeUndefined()
  })
})

/** A chat-tier player using `say` to get a command into the room for somebody else to obey. */
describe('laundering a command through say', () => {
  it('cannot make an agent utter the prefix', () => {
    expect(sayable(['!osm', 'run', '/op', 'Eve'])).toBeUndefined()
  })

  it('cannot smuggle it past the separator either', () => {
    // Allowed to be said - and harmless, because the line it produces does not parse as a command.
    const said = sayable(['»', '!osm', 'run', '/op', 'Eve'])
    expect(said).toBe('» !osm run /op Eve')

    const heard = asAura('Bot', said!)
    expect(commandIn(spokenIn(heard, AURA)!)).toBeUndefined()
  })
})

/** What the guards cannot see. Both are properties of the server, not of the parser. */
describe('what the parser genuinely cannot defend against', () => {
  it('trusts a rendered name, whoever the server says that is', () => {
    // A nickname plugin, or an offline-mode server where anybody may log in as any name. The line is
    // well formed and the speaker reads as `integr`, because the server said so.
    const line = asDa('integr', '!osm run /op Eve')

    expect(senderOf(line, DA)).toBe('integr')
    expect(commandIn(spokenIn(line, DA)!)?.name).toBe('run')
  })

  it('is only as good as the pattern it is given', () => {
    // A pattern with an optional prefix lets a name at position zero be a speaker, so anything the
    // server prints as `name: text` becomes that player talking.
    const loose = compile('^(?:.*?[\\s\\]])?([A-Za-z0-9_]{1,16}):', 'loose')!

    expect(senderOf('Balance: $10,000', loose)).toBe('Balance')
    expect(senderOf('Balance: $10,000', DA)).toBe(SERVER)
  })
})
