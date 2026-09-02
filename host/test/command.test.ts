import { describe, expect, it } from 'vitest'

import { trustedFrom } from '../src/agent/bot.ts'
import {
  addressedTo,
  allows,
  COMMANDS,
  commandIn,
  grantFrom,
  helpLine,
  PREFIX,
  runnable,
  sayable,
  TRUST,
  type Grant,
} from '../src/agent/command.ts'

/** A broad grant, which most entries are. */
const tier = (which: typeof TRUST.chat | typeof TRUST.commands): Grant => ({ kind: 'tier', tier: which })

/** An exact one, which is the point of granting commands individually. */
const only = (...commands: string[]): Grant => ({ kind: 'only', commands: new Set(commands) })
import { compile, spokenIn, VANILLA, WHISPER_COMMAND, whisperWith } from '../src/agent/sender.ts'

/**
 * The one thing in this host that acts on what a stranger typed.
 *
 * Everything else arrives over the authenticated socket from the backend. So the parser has to be
 * certain rather than helpful: a line it is not sure about is chat, and chat is ignored.
 */
describe('reading a command out of chat', () => {
  it('reads one addressed to everybody', () => {
    expect(commandIn('!osm id')).toEqual({ account: undefined, name: 'id', args: [] })
  })

  it('reads one addressed to an account', () => {
    expect(commandIn('!osm intemeow id')).toEqual({ account: 'intemeow', name: 'id', args: [] })
  })

  it('keeps whatever came after the command', () => {
    expect(commandIn('!osm intemeow id one two')).toEqual({ account: 'intemeow', name: 'id', args: ['one', 'two'] })
  })

  it('forgives the spacing of somebody typing in a hurry', () => {
    expect(commandIn('  !osm   intemeow    id  ')).toEqual({ account: 'intemeow', name: 'id', args: [] })
  })

  /**
   * `!osm id` is the command asked of everybody, not a command asked of an agent called `id`. The
   * cost is written down rather than hidden: an agent whose account is `id` cannot be named.
   */
  it('reads a known command as a command, never as an account', () => {
    expect(commandIn('!osm id')?.account).toBeUndefined()
    expect(commandIn('!osm id id')).toEqual({ account: undefined, name: 'id', args: ['id'] })
  })

  it('is not a command at all when it names no command this build has', () => {
    expect(commandIn('!osm intemeow explode')).toBeUndefined()
    expect(commandIn('!osm explode')).toBeUndefined()
    expect(commandIn('!osm intemeow')).toBeUndefined()
    expect(commandIn('!osm')).toBeUndefined()
  })

  it('refuses an account that could not be one', () => {
    expect(commandIn('!osm [MEMBER] id')).toBeUndefined()
    expect(commandIn('!osm ThisNameIsFarTooLong id')).toBeUndefined()
    expect(commandIn('!osm ʙʟᴏᴏᴍ id')).toBeUndefined()
  })

  it('takes an @ in front of the account, because chat has taught everybody to', () => {
    expect(commandIn('!osm @intemeow id')).toEqual({ account: 'intemeow', name: 'id', args: [] })
  })

  /**
   * Anchored at the start of what was **typed**. `commandIn` is handed that, never the rendered
   * line — see `spokenIn`, which is what takes the server's decoration off the front.
   */
  it('cannot be triggered from inside a sentence', () => {
    expect(commandIn('has anybody tried !osm id yet')).toBeUndefined()
    expect(commandIn('look: !osm id')).toBeUndefined()
  })

  it('ignores a prefix that is only nearly the prefix', () => {
    expect(commandIn('!osmium id')).toBeUndefined()
    expect(commandIn('!OSM id')).toBeUndefined()
    expect(commandIn('osm id')).toBeUndefined()
    expect(commandIn(`${PREFIX}id`)).toBeUndefined()
  })

  it('survives whatever is typed at it', () => {
    for (const line of ['', '   ', '!', '!osm '.repeat(50)]) {
      expect(() => commandIn(line)).not.toThrow()
    }
  })
})

/**
 * The half that was wrong the first time.
 *
 * `commandIn` anchors at position zero, which is only meaningful once the server's own prefix has
 * been taken off. Anchoring on the raw line looked stricter and simply never matched: on a server
 * that renders a rank the prefix is nowhere near the start.
 */
describe('finding what the player actually typed', () => {
  const AURA = compile('^\\s*(?:\\[[^\\]]*\\]\\s*)*([A-Za-z0-9_]{1,16})(?:\\s*\\[[^\\]]*\\])*\\s*»', 'aura')!
  const COLON = compile('^(?:.*?[\\s\\]])?([A-Za-z0-9_]{1,16}):', 'colon')!

  it('reads a command off a real rendered line', () => {
    // Copied out of chat_messages, leading space and all.
    const line = ' [★95] [HEAD-MOD] brizie » !osm id'

    expect(spokenIn(line, AURA)).toBe('!osm id')
    expect(commandIn(spokenIn(line, AURA)!)).toEqual({ account: undefined, name: 'id', args: [] })
  })

  it('works whatever the server puts around it', () => {
    expect(spokenIn(' [★5] [MEMBER] intemeow » !osm @intemeow id', AURA)).toBe('!osm @intemeow id')
    expect(spokenIn('⟨|||⟨𝓘𝓷𝓽⟩|||⟩ integr: !osm id', COLON)).toBe('!osm id')
    expect(spokenIn('<Notch> !osm id', VANILLA)).toBe('!osm id')
  })

  /** A message that itself contains the separator must not shift where the command may start. */
  it('stops at the first separator, so a message cannot move the boundary', () => {
    expect(spokenIn(' [★1] [MEMBER] Eve » » !osm id', AURA)).toBe('» !osm id')
    expect(commandIn(spokenIn(' [★1] [MEMBER] Eve » » !osm id', AURA)!)).toBeUndefined()
  })

  it('says nothing about a line that is not chat', () => {
    expect(spokenIn(' [➕]  intemeow joined the server. (8👤)', AURA)).toBeUndefined()
    expect(spokenIn('(❗) Your flight mode has been enabled.', AURA)).toBeUndefined()
  })
})

/**
 * `say` is the first command that makes an agent do something rather than report something, so it
 * is the first place the difference between speech and action has to be drawn.
 */
describe('what an agent may be made to say', () => {
  it('says what was asked, rejoined', () => {
    expect(sayable(['hello', 'there'])).toBe('hello there')
    expect(commandIn('!osm say hello there')).toEqual({ account: undefined, name: 'say', args: ['hello', 'there'] })
    expect(commandIn('!osm intemeow say hi')).toEqual({ account: 'intemeow', name: 'say', args: ['hi'] })
  })

  it('has nothing to say when nothing was given', () => {
    expect(sayable([])).toBeUndefined()
    expect(sayable(['   '])).toBeUndefined()
  })

  /**
   * The escalation this guards. Minecraft runs a leading `/` as a server command under the agent's
   * own permissions, so without this a player trusted to make a bot talk could make an operator bot
   * op them.
   */
  it('will not run a server command', () => {
    expect(sayable(['/op', 'Eve'])).toBeUndefined()
    expect(sayable(['/kick', 'someone'])).toBeUndefined()
    expect(sayable(['/'])).toBeUndefined()
  })

  /** An agent saying the prefix is a command in the room, heard by every other agent. */
  it('will not issue a command to the fleet', () => {
    expect(sayable(['!osm', 'say', 'again'])).toBeUndefined()
    expect(sayable(['!osm', 'id'])).toBeUndefined()
  })

  /** Mentioning either is ordinary conversation; only leading with one is the problem. */
  it('still says a sentence that merely mentions them', () => {
    expect(sayable(['try', '!osm', 'id'])).toBe('try !osm id')
    expect(sayable(['use', '/home', 'to', 'get', 'back'])).toBe('use /home to get back')
  })

  it('truncates rather than refusing something too long', () => {
    const said = sayable([`x${'y'.repeat(400)}`])

    expect(said).toHaveLength(256)
  })
})

/**
 * Generated from the command table rather than written out, so it cannot go stale — which is the
 * failure that matters, because nothing breaks when help is wrong.
 */
describe('help', () => {
  it('names every command this build has', () => {
    for (const name of Object.keys(COMMANDS)) expect(helpLine(tier(TRUST.commands))).toContain(name)
  })

  it('shows what each one takes', () => {
    expect(helpLine(tier(TRUST.commands))).toContain('say <message>')
  })

  it('reads as something somebody could type back', () => {
    expect(helpLine(tier(TRUST.commands)).startsWith(PREFIX)).toBe(true)
  })

  /** One line per agent per `help`, so a fleet answering must not add up to a spam kick. */
  it('fits in one Minecraft message', () => {
    expect(helpLine(tier(TRUST.commands)).length).toBeLessThanOrEqual(256)
  })

  it('is a command like any other', () => {
    expect(commandIn('!osm help')).toEqual({ account: undefined, name: 'help', args: [] })
    expect(commandIn('!osm intemeow help')).toEqual({ account: 'intemeow', name: 'help', args: [] })
  })

  /**
   * The invariant that matters. Help leads with the prefix, because that is what somebody has to
   * type — and every other agent in the room hears it. So the line an agent says must not itself
   * parse as a command, or one `help` would set the whole fleet off answering each other.
   */
  it('is not itself a command, so a fleet cannot set itself off', () => {
    expect(commandIn(helpLine(tier(TRUST.commands)))).toBeUndefined()
  })
})

/**
 * The tier, and the whole reason there are two.
 *
 * `commands` is close to handing somebody the agent's Minecraft account — on an operator bot it is
 * `/op`. So it is never what an unsure answer resolves to.
 */
describe('how far a player is trusted', () => {
  it('lets a chat-trusted player use the chat commands', () => {
    expect(allows(tier(TRUST.chat), 'id')).toBe(true)
    expect(allows(tier(TRUST.chat), 'say')).toBe(true)
    expect(allows(tier(TRUST.chat), 'help')).toBe(true)
  })

  it('does not let a chat-trusted player run server commands', () => {
    expect(allows(tier(TRUST.chat), 'run')).toBe(false)
  })

  it('lets a command-trusted player do everything', () => {
    for (const name of Object.keys(COMMANDS)) expect(allows(tier(TRUST.commands), name)).toBe(true)
  })

  it('lets somebody who is not on the list do nothing at all', () => {
    for (const name of Object.keys(COMMANDS)) expect(allows(undefined, name)).toBe(false)
  })

  it('reads the tier off an entry, and falls back to the safe one', () => {
    expect(trustedFrom('integr:commands').get('integr')).toEqual(tier(TRUST.commands))
    expect(trustedFrom('integr').get('integr')).toEqual(tier(TRUST.chat))
    // A tier a newer Osmium wrote must not grant more than this build understands.
    // Not a tier, so it is a list of one - and a command that cannot be named is refused, so this
    // grants nothing at all. Falling back to `chat` here would grant the seven harmless commands
    // to an entry that plainly asked for something else.
    expect(trustedFrom('integr:everything').get('integr')).toEqual(only('everything'))
    expect(trustedFrom('integr:COMMANDS').get('integr')).toEqual(only('COMMANDS'))
    expect(allows(trustedFrom('integr:everything').get('integr'), 'say')).toBe(false)
    expect(allows(trustedFrom('integr:COMMANDS').get('integr'), 'run')).toBe(false)
  })

  it('only offers help for what the asker could actually use', () => {
    for (const elevated of ['run', 'disconnect', 'reconnect']) {
      expect(helpLine(tier(TRUST.chat))).not.toContain(elevated)
      expect(helpLine(tier(TRUST.commands))).toContain(elevated)
    }

    // And still offers the ones they can use.
    for (const plain of ['id', 'ping', 'health', 'food', 'uptime', 'say', 'help']) {
      expect(helpLine(tier(TRUST.chat))).toContain(plain)
    }
  })
})

/** The escalated command. There is no list of safe ones, so the tier is the whole decision. */
describe('running a server command', () => {
  it('sends what was typed', () => {
    expect(runnable(['/tp', 'me'])).toBe('/tp me')
    expect(commandIn('!osm run /tp me')).toEqual({ account: undefined, name: 'run', args: ['/tp', 'me'] })
  })

  it('adds the slash when somebody left it off', () => {
    expect(runnable(['tp', 'me'])).toBe('/tp me')
  })

  /** `//set stone` is WorldEdit, not a typo — collapsing the slashes would run a different command. */
  it('leaves a doubled slash alone', () => {
    expect(runnable(['//set', 'stone'])).toBe('//set stone')
  })

  it('has nothing to run when nothing was given', () => {
    expect(runnable([])).toBeUndefined()
    expect(runnable(['  '])).toBeUndefined()
  })
})

/**
 * A question asked privately is answered privately, which needs the server's own command for it —
 * and the answer must never simply vanish because that command was written wrong.
 */
describe('answering privately', () => {
  it('fills the template in', () => {
    expect(whisperWith(WHISPER_COMMAND, 'integr', 'Agent 27 at 42ms')).toBe('/msg integr Agent 27 at 42ms')
  })

  it('takes whatever shape a server wants', () => {
    expect(whisperWith('/w {name} {message}', 'integr', 'hi')).toBe('/w integr hi')
    expect(whisperWith('/tell {name} :: {message}', 'integr', 'hi')).toBe('/tell integr :: hi')
  })

  /** Half-filling would whisper an empty line on every reply, with nowhere for anybody to look. */
  it('refuses a template that would drop the message or the name', () => {
    expect(whisperWith('/msg {name}', 'integr', 'hi')).toBeUndefined()
    expect(whisperWith('/msg {message}', 'integr', 'hi')).toBeUndefined()
    expect(whisperWith('/msg', 'integr', 'hi')).toBeUndefined()
  })

  it('refuses a recipient that could not be a player', () => {
    expect(whisperWith(WHISPER_COMMAND, '[MEMBER]', 'hi')).toBeUndefined()
    expect(whisperWith(WHISPER_COMMAND, '', 'hi')).toBeUndefined()
  })
})

describe('who a command is for', () => {
  const everybody = { account: undefined, name: 'id', args: [] } as const
  const somebody = { account: 'intemeow', name: 'id', args: [] } as const

  it('addresses every agent when no account was named', () => {
    expect(addressedTo(everybody, 'intemeow')).toBe(true)
    expect(addressedTo(everybody, 'someone_else')).toBe(true)
    // Including one that has not finished signing in, which will simply not be in game to answer.
    expect(addressedTo(everybody, undefined)).toBe(true)
  })

  it('addresses only the account named', () => {
    expect(addressedTo(somebody, 'intemeow')).toBe(true)
    expect(addressedTo(somebody, 'someone_else')).toBe(false)
    expect(addressedTo(somebody, undefined)).toBe(false)
  })

  it('does not care about capitals, because nobody typing in chat does', () => {
    expect(addressedTo({ ...somebody, account: 'INTEMEOW' }, 'intemeow')).toBe(true)
  })
})

/**
 * The trust list, and the reason it is a Set rather than an optional pattern: an unset setting must
 * be the safe answer. On a public server the unsafe answer is every stranger standing in spawn.
 */
describe('who is trusted', () => {
  it('trusts nobody when nobody has been named', () => {
    expect(trustedFrom(undefined).size).toBe(0)
    expect(trustedFrom('').size).toBe(0)
    expect(trustedFrom('   ').size).toBe(0)
    expect(trustedFrom(',,,').size).toBe(0)
  })

  it('reads the list the interface wrote', () => {
    expect([...trustedFrom('integr,brizie').keys()]).toEqual(['integr', 'brizie'])
  })

  it('matches however the name was capitalised', () => {
    expect(trustedFrom('Integr').has('integr')).toBe(true)
    expect(trustedFrom('integr').has('INTEGR'.toLowerCase())).toBe(true)
  })

  it('drops anything that could not be a Minecraft name', () => {
    const trusted = trustedFrom('integr, [MEMBER], ʙʟᴏᴏᴍ, ThisNameIsFarTooLong')

    expect([...trusted.keys()]).toEqual(['integr'])
  })
})

/**
 * Granting commands one at a time.
 *
 * The reason this exists is the player who should have one command out of the powerful tier and
 * none of the others, so what matters is that a list means *exactly* what it names.
 */
describe('granting commands one at a time', () => {
  it('reads a list joined by plus', () => {
    expect(trustedFrom('integr:run+say').get('integr')).toEqual(only('run', 'say'))
  })

  it('grants what the list names', () => {
    expect(allows(only('run'), 'run')).toBe(true)
  })

  /** Exact in both directions: "only `run`" must not quietly mean "`run` and the harmless ones". */
  it('refuses everything the list does not name, chat commands included', () => {
    expect(allows(only('run'), 'say')).toBe(false)
    expect(allows(only('run'), 'help')).toBe(false)
    expect(allows(only('run'), 'id')).toBe(false)
    expect(allows(only('run'), 'disconnect')).toBe(false)
  })

  it('grants nothing when the list names nothing', () => {
    expect(grantFrom('none')).toEqual(only())
    for (const name of Object.keys(COMMANDS)) expect(allows(only(), name)).toBe(false)
  })

  /** A command a newer Osmium wrote is kept, and refused, rather than silently widening the grant. */
  it('refuses a command it cannot name', () => {
    expect(allows(only('selfDestruct'), 'selfDestruct')).toBe(true)
    expect(allows(tier(TRUST.chat), 'selfDestruct')).toBe(false)
    expect(allows(tier(TRUST.commands), 'selfDestruct')).toBe(false)
  })

  it('offers help only for what an exact grant reaches', () => {
    const line = helpLine(only('run'))

    expect(line).toContain('run')
    expect(line).not.toContain('say')
    expect(line).not.toContain('help')
  })

  it('reads a bare tier as a tier, not as a list of one', () => {
    expect(grantFrom('commands')).toEqual(tier(TRUST.commands))
    expect(grantFrom('chat')).toEqual(tier(TRUST.chat))
    expect(grantFrom(undefined)).toEqual(tier(TRUST.chat))
    expect(grantFrom('')).toEqual(tier(TRUST.chat))
  })
})
