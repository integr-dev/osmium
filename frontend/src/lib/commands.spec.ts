import { describe, expect, it, vi } from 'vitest'
import { buildCommands, rank, type Command, type CommandContext } from './commands'
import type { FleetAgent } from '../stores/agents'

/**
 * The palette's two jobs: offer only what this operator could actually do, and put what they meant
 * at the top. Both are here rather than in the component, so they can be tested without mounting —
 * the same line the rest of this suite draws.
 */
function agent(overrides: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: 1,
    label: 'eu-1-agent-1',
    hostId: 7,
    hostName: 'host-eu',
    serverAddress: 'mc.example.com:25565',
    state: 'LINKED',
    mcUsername: 'Mason_01',
    mcUuid: null,
    onlineSince: null,
    telemetry: null,
    chatListener: false,
    build: { blocksPlaced: 0, task: '' },
    ...overrides,
  } as FleetAgent
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    agents: [],
    hosts: [],
    can: () => true,
    hostReachable: () => true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  }
}

const ids = (commands: Command[]) => commands.map((command) => command.id)

describe('what the palette offers', () => {
  it('hides pages the account cannot open', () => {
    const offered = ids(buildCommands(context({ can: (node) => node === 'fleet.read' })))

    // The same nodes the route guard checks. Offering these would turn a keystroke into a bounce
    // back to the dashboard, which reads as a bug.
    expect(offered).not.toContain('go:audit')
    expect(offered).not.toContain('go:accounts')
    expect(offered).not.toContain('go:configuration')
    expect(offered).toContain('go:dashboard')
  })

  it('offers connect for an agent that could connect', () => {
    const offered = ids(buildCommands(context({ agents: [agent()] })))

    expect(offered).toContain('connect:1')
    expect(offered).not.toContain('disconnect:1')
  })

  it('offers disconnect for one that is online', () => {
    const offered = ids(buildCommands(context({ agents: [agent({ state: 'ONLINE' })] })))

    expect(offered).toContain('disconnect:1')
    expect(offered).not.toContain('connect:1')
  })

  /** Each of these would come back a 409 or a 503 for a keystroke that looked like it would work. */
  it('offers neither when the command could not go through', () => {
    expect(ids(buildCommands(context({ agents: [agent({ serverAddress: null })] })))).not.toContain('connect:1')
    expect(ids(buildCommands(context({ agents: [agent({ state: 'UNLINKED' })] })))).not.toContain('connect:1')
    expect(
      ids(buildCommands(context({ agents: [agent()], hostReachable: () => false }))),
    ).not.toContain('connect:1')
  })

  it('offers no agent commands without fleet.control', () => {
    const offered = ids(buildCommands(context({ agents: [agent()], can: (node) => node !== 'fleet.control' })))

    // The agent is still reachable as a destination — reading is a different node from acting.
    expect(offered).toContain('agent:1')
    expect(offered).not.toContain('connect:1')
  })

  /** A palette is for fast, reversible moves. One wrong Enter must not destroy anything. */
  it('never offers to delete an agent', () => {
    const offered = ids(buildCommands(context({ agents: [agent()] })))

    expect(offered.some((id) => id.startsWith('delete'))).toBe(false)
  })
})

describe('ranking', () => {
  const commands: Command[] = [
    { id: 'a', section: 'agents', label: 'eu-1-agent-1' },
    { id: 'b', section: 'agents', label: 'us-2-agent-4' },
    { id: 'c', section: 'agents', label: 'Mason', hint: 'eu-1-agent-1' },
  ]

  it('matches a subsequence, not just a substring', () => {
    // The shape of name a fleet actually gets, and exactly what a substring search misses.
    expect(ids(rank(commands, 'eu1a1'))).toEqual(['a', 'c'])
  })

  it('prefers the tighter match', () => {
    const scattered: Command[] = [
      { id: 'far', section: 'agents', label: 'e-x-x-x-u' },
      { id: 'near', section: 'agents', label: 'eu-1' },
    ]

    expect(ids(rank(scattered, 'eu'))[0]).toBe('near')
  })

  it('puts a name match above one that only matches the second line', () => {
    // Somebody typing a name means the name.
    expect(ids(rank(commands, 'eu-1-agent-1'))).toEqual(['a', 'c'])
  })

  it('drops what does not match at all', () => {
    expect(rank(commands, 'zzz')).toEqual([])
  })

  it('leaves everything in place for an empty query', () => {
    expect(ids(rank(commands, '   '))).toEqual(['a', 'b', 'c'])
  })
})
