import { describe, expect, it } from 'vitest'
import { belongsTo, parseScopeKey, scopeFilter, scopeKey, speakerCandidates } from './chat'
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

  it('puts an agent’s own conversation on the agent, not on the server', () => {
    expect(belongsTo(line({ scope: 'DIRECT' }), AGENT)).toBe(true)
    expect(belongsTo(line({ scope: 'DIRECT' }), SERVER)).toBe(false)
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
