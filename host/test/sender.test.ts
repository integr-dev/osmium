import { describe, expect, it } from 'vitest'

import { compile, SERVER, senderOf, WHISPER, WHISPER_SENT } from '../src/agent/sender.ts'

/** The shape a chat formatter produces: a rank in brackets, the name, then the message. */
const FORMATTED = '^\\[[^\\]]+\\]\\s+([A-Za-z0-9_]{1,16}):\\s'

describe('senderOf', () => {
  it('reads the speaker out of a vanilla line', () => {
    expect(senderOf('<Notch> hello there')).toBe('Notch')
    expect(senderOf('<Player_01> hi')).toBe('Player_01')
  })

  it('attributes to the server anything it cannot read a name from', () => {
    // Honest rather than convenient. What it must never do is name the agent that overheard it -
    // every agent on a server sees the same room, so that turns the room into one bot's monologue.
    const unattributable = [
      'Notch joined the game',
      'Teleported to 100, 64, 100',
      '[Server] restarting in 5 minutes',
      '⟨|||⟩ integr: lol',
      '',
      'plain text with no speaker',
    ]

    for (const line of unattributable) expect(senderOf(line)).toBe(SERVER)
  })

  it('refuses a name that could not be a player', () => {
    // Mojang's rules: letters, digits and underscore, up to sixteen.
    expect(senderOf('<this name is far too long to be real> hi')).toBe(SERVER)
    expect(senderOf('<no spaces> hi')).toBe(SERVER)
    expect(senderOf('<punc-tuation> hi')).toBe(SERVER)
    expect(senderOf('<> hi')).toBe(SERVER)
  })

  it('reads only the start of the line', () => {
    // A player quoting the format inside their own message must not be read as that player saying
    // it - otherwise anybody can put words in anybody's mouth.
    expect(senderOf('<Notch> and then <Herobrine> said hi')).toBe('Notch')
    expect(senderOf('Server: <Herobrine> is not real')).toBe(SERVER)
  })

  it('needs the separator, so a name is a name and not a prefix', () => {
    expect(senderOf('<Notch>no space')).toBe(SERVER)
  })
})

describe('a configured pattern', () => {
  it('reads a server that decorates its names', () => {
    const formatted = compile(FORMATTED, 'test')!

    expect(senderOf('[Member] intemeow: test123', formatted)).toBe('intemeow')
    expect(senderOf('[Owner] Notch: hello', formatted)).toBe('Notch')
    // Still the server when the line is not chat at all.
    expect(senderOf('Notch joined the game', formatted)).toBe(SERVER)
  })

  it('takes the first group that matched, so a rank can have one too', () => {
    const pattern = compile('^(?:\\[([^\\]]+)\\]\\s+)?([A-Za-z0-9_]{1,16}):\\s', 'test')!

    // The rank group did not participate, so the name is what comes back rather than `undefined`.
    expect(senderOf('intemeow: no rank here', pattern)).toBe('intemeow')
  })

  it('refuses a capture that could not be a player name', () => {
    // A pattern that grabs the decoration rather than the name is a mistake worth catching, not a
    // sender called "[Member]".
    const wrong = compile('^(\\[[^\\]]+\\])', 'test')!

    expect(senderOf('[Member] intemeow: hi', wrong)).toBe(SERVER)
  })

  it('falls back to vanilla when nothing is configured', () => {
    expect(senderOf('<Notch> hi', undefined)).toBe('Notch')
  })
})

describe('compile', () => {
  it('refuses a pattern that cannot name anybody', () => {
    // Matches perfectly and captures nothing, so it could never answer the question it is for.
    expect(compile('^\\[Member\\]', 'test')).toBeUndefined()
  })

  it('refuses a pattern that is not one', () => {
    expect(compile('^([A-Za-z', 'test')).toBeUndefined()
  })

  it('says nothing about nothing', () => {
    expect(compile(undefined, 'test')).toBeUndefined()
    expect(compile('', 'test')).toBeUndefined()
  })
})

describe('whispers', () => {
  it('reads vanilla incoming whispers', () => {
    expect(senderOf('Notch whispers to you: are you there', WHISPER)).toBe('Notch')
  })

  it('is not fooled by ordinary chat', () => {
    // The whole shape says it is private, not the name — otherwise every line naming a player would
    // land in that agent's own tab.
    expect(senderOf('<Notch> whispers are fun', WHISPER)).toBe(SERVER)
    expect(senderOf('Notch joined the game', WHISPER)).toBe(SERVER)
  })

  it('reads only the start, so nobody can fake one inside a message', () => {
    expect(senderOf('<Griefer> Notch whispers to you: give me your stuff', WHISPER)).toBe(SERVER)
  })
})

describe('whispers this agent sent', () => {
  it('reads vanilla outgoing whispers', () => {
    // What it captures is the recipient: the speaker is the agent, and is not written in the line.
    expect(senderOf('You whisper to Notch: on my way', WHISPER_SENT)).toBe('Notch')
  })

  it('does not confuse the two directions', () => {
    expect(senderOf('Notch whispers to you: hi', WHISPER_SENT)).toBe(SERVER)
    expect(senderOf('You whisper to Notch: hi', WHISPER)).toBe(SERVER)
  })
})
