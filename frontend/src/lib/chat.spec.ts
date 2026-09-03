import { describe, expect, it } from 'vitest'
import {
  agentBehind,
  agentsByAccount,
  belongsTo,
  foldRun,
  isSuppressed,
  parseScopeKey,
  scopeFilter,
  scopeKey,
  speakerCandidates,
  type ChatRow,
} from './chat'
import type { ChatMessageResponse } from '../api/client'
import type { FleetAgent } from '../stores/agents'

/**
 * The rail and the agent page share one panel, so the question "does this line belong here" is
 * answered in one place. Getting it wrong is not visible in a screenshot — it shows up as a server's
 * chatter slowly filling an agent's conversation.
 */
function line(overrides: Partial<ChatMessageResponse> = {}): ChatMessageResponse {
  return {
    id: 1,
    at: '2026-08-14T10:00:00Z',
    agentId: 1,
    agentLabel: 'eu-1-agent-1',
    serverAddress: 'mc.example.com:25565',
    scope: 'DIRECT',
    from: 'Steve',
    text: 'hello',
    // Plain: a host sends no component tree for a line it has none for, and every one of these
    // questions is answered from the envelope rather than the words.
    components: null,
    ...overrides,
  }
}

function agent(overrides: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: 1,
    label: 'eu-1-agent-1',
    hostId: 7,
    serverAddress: 'mc.example.com:25565',
    state: 'ONLINE',
    chatListener: false,
    ...overrides,
  } as FleetAgent
}

const SERVER = { kind: 'server', address: 'mc.example.com:25565' } as const
const AGENT = { kind: 'agent', id: 1 } as const

describe('which panel a line belongs in', () => {
  it('puts global chat on the server, not on the agent that forwarded it', () => {
    const global = line({ scope: 'GLOBAL' })

    expect(belongsTo(global, SERVER)).toBe(true)
    // The listener forwards it, so it carries that agent's id — and is still not about it.
    expect(belongsTo(global, AGENT)).toBe(false)
  })

  /** Not the mirror of the above: a whisper to one agent still happened on that server. */
  it('puts every scope on the server, not only the global channel', () => {
    for (const scope of ['GLOBAL', 'DIRECT', 'OUTBOUND'] as const) {
      expect(belongsTo(line({ scope }), SERVER)).toBe(true)
    }
  })

  it('puts an agent’s own conversation on the agent as well', () => {
    expect(belongsTo(line({ scope: 'DIRECT' }), AGENT)).toBe(true)
  })

  it('keeps servers apart', () => {
    expect(belongsTo(line({ scope: 'GLOBAL', serverAddress: 'other:25565' }), SERVER)).toBe(false)
  })

  it('keeps agents apart', () => {
    expect(belongsTo(line({ agentId: 2 }), AGENT)).toBe(false)
  })
})

describe('scope keys', () => {
  /** Addresses carry a port, so the separator appears twice and only the first one splits. */
  it('survives a round trip through storage', () => {
    expect(parseScopeKey(scopeKey(SERVER))).toEqual(SERVER)
    expect(parseScopeKey(scopeKey(AGENT))).toEqual(AGENT)
  })

  it('treats anything unrecognised as no scope at all', () => {
    expect(parseScopeKey(null)).toBeNull()
    expect(parseScopeKey('')).toBeNull()
    expect(parseScopeKey('server:')).toBeNull()
    expect(parseScopeKey('agent:eu-1')).toBeNull()
    expect(parseScopeKey('nonsense')).toBeNull()
  })

  it('asks the endpoint for exactly one filter', () => {
    expect(scopeFilter(SERVER)).toEqual({ server: 'mc.example.com:25565' })
    expect(scopeFilter(AGENT)).toEqual({ agentId: 1 })
  })
})

describe('who can speak', () => {
  it('puts the listener first on a server', () => {
    const candidates = speakerCandidates(
      [agent({ id: 1 }), agent({ id: 2, chatListener: true })],
      SERVER,
    )

    expect(candidates.map((it) => it.id)).toEqual([2, 1])
  })

  it('leaves out agents that are not in game or not there', () => {
    const candidates = speakerCandidates(
      [agent({ id: 1, state: 'LINKED' }), agent({ id: 2, serverAddress: 'other:25565' })],
      SERVER,
    )

    expect(candidates).toEqual([])
  })

  /** The panel disables the box and says why. An empty picker would explain nothing. */
  it('offers an offline agent in its own scope', () => {
    expect(speakerCandidates([agent({ state: 'LINKED' })], AGENT).map((it) => it.id)).toEqual([1])
  })

  it('offers nobody for an agent it has never heard of', () => {
    expect(speakerCandidates([], AGENT)).toEqual([])
  })
})

/**
 * Chat names an account and an operator thinks in agents, and one account can be played by two
 * agents on two servers. Keyed on the account alone, the second overwrote the first and every line
 * from either was labelled with whichever happened to be built last.
 */
describe('the agent behind a line', () => {
  const bot = (id: number, label: string, mcUsername: string, serverAddress: string | null) =>
    ({ id, label, mcUsername, serverAddress, state: 'ONLINE' }) as FleetAgent

  const HERE = bot(1, 'eu-builder', 'Mason_04', 'mc.example.com:25565')
  const THERE = bot(2, 'us-builder', 'Mason_04', 'other.example.com:25565')

  it('tells two agents sharing an account apart by server', () => {
    const named = agentsByAccount([HERE, THERE])

    expect(agentBehind(line({ from: 'Mason_04', serverAddress: 'mc.example.com:25565' }), named)).toBe('eu-builder')
    expect(agentBehind(line({ from: 'Mason_04', serverAddress: 'other.example.com:25565' }), named)).toBe('us-builder')
  })

  it('matches however the server cased the name', () => {
    const named = agentsByAccount([HERE])

    expect(agentBehind(line({ from: 'mason_04', serverAddress: 'mc.example.com:25565' }), named)).toBe('eu-builder')
  })

  /** An agent moved to another server would otherwise lose its name on everything it said before. */
  it('still names a sole player of an account on a line from anywhere', () => {
    const named = agentsByAccount([HERE])

    expect(agentBehind(line({ from: 'Mason_04', serverAddress: 'moved.example.com:25565' }), named)).toBe('eu-builder')
  })

  /** The ambiguity the pair exists to settle is real here, so guessing is worse than saying nothing. */
  it('says nothing rather than guessing when the account is shared', () => {
    const named = agentsByAccount([HERE, THERE])

    expect(agentBehind(line({ from: 'Mason_04', serverAddress: 'moved.example.com:25565' }), named)).toBeUndefined()
  })

  it('says nothing about an account the fleet does not play', () => {
    const named = agentsByAccount([HERE])

    expect(agentBehind(line({ from: 'Notch' }), named)).toBeUndefined()
    expect(agentBehind(line({ from: 'server' }), named)).toBeUndefined()
  })

  it('ignores an agent that has never been set up', () => {
    expect(agentsByAccount([bot(3, 'unlinked', '', null)]).size).toBe(0)
  })
})

/**
 * The row drawn where refused lines would have been. It is the only thing in the panel that grows
 * in place rather than arriving, so what it does on the second event is the whole behaviour.
 */
describe('foldRun', () => {
  function run(count: number, from: string | null = 'Notch') {
    return { at: '2026-09-03T12:00:00Z', serverAddress: 'play.example.com', from, count }
  }

  it('starts a row for the first of a run', () => {
    const rows: ChatRow[] = [line()]

    const fresh = foldRun(rows, run(1), -1)

    expect(fresh).toEqual({ id: -1, ...run(1) })
  })

  it('grows the row already at the top instead of adding another', () => {
    const rows: ChatRow[] = [{ id: -1, ...run(1) }, line()]

    expect(foldRun(rows, run(2), -2)).toBeNull()
    expect(foldRun(rows, run(412), -3)).toBeNull()
    expect(rows).toHaveLength(2)
    expect(isSuppressed(rows[0]!) && rows[0]!.count).toBe(412)
  })

  /**
   * A line getting through closes the gap, and the backend says so by counting from one again. The
   * row it closed is left where it is: it is a true record of a hole further up the transcript.
   */
  it('starts a new row once a line has got through', () => {
    const rows: ChatRow[] = [line(), { id: -1, ...run(9) }]

    const fresh = foldRun(rows, run(1), -2)

    expect(fresh).toEqual({ id: -2, ...run(1) })
  })

  /**
   * Self-correcting rather than trusting the sequence. A panel that missed an event would otherwise
   * keep growing a gap the backend has already closed.
   */
  it('grows nothing when the row above is a line', () => {
    const rows: ChatRow[] = [line()]

    expect(foldRun(rows, run(7), -1)).toEqual({ id: -1, ...run(7) })
  })

  /** Either name would be a lie about most of a gap two people share. */
  it('stops naming anybody once a second person is in the same gap', () => {
    const rows: ChatRow[] = [{ id: -1, ...run(1) }]

    foldRun(rows, run(2, 'Alex'), -2)

    expect(isSuppressed(rows[0]!) && rows[0]!.from).toBeNull()
  })
})
