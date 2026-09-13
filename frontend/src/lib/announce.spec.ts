import { describe, expect, it } from 'vitest'
import type { AgentPathResponse, AgentResponse, SchematicResponse } from '../api/client'
import { LOCALES } from '../i18n'
import { agentNotice, PATH_REASONS, pathNotice, schematicNotice } from './announce'

function path(fields: Partial<AgentPathResponse>): AgentPathResponse {
  return {
    agentId: 6,
    state: 'MOVING',
    dimension: 'overworld',
    goal: { x: 128.4, y: 64, z: -340.6 },
    nodes: null,
    work: null,
    progress: 0,
    reason: null,
    closest: false,
    ...fields,
  } as AgentPathResponse
}

function agent(fields: Partial<AgentResponse>): AgentResponse {
  return {
    id: 6,
    label: 'Mason_6',
    hostId: 1,
    hostName: 'eu-1',
    serverAddress: 'alpha.example:25565',
    state: 'ONLINE',
    mcUsername: null,
    mcUuid: null,
    settings: {},
    chatListener: false,
    rejoining: false,
    onlineSince: null,
    telemetry: null,
    ...fields,
  }
}

function schematic(status: SchematicResponse['status']): SchematicResponse {
  return { id: 3, name: 'Spawn', status } as SchematicResponse
}

describe('what a journey says', () => {
  it('says it arrived, at whole blocks, with a link to the agent', () => {
    expect(pathNotice(path({ state: 'ARRIVED' }), 'Mason_6')).toEqual({
      kind: 'success',
      key: 'toast.path.arrived',
      params: { name: 'Mason_6', goal: '128, 64, -341' },
      to: { name: 'agent', params: { id: '6' } },
      topic: 'path:6',
      fade: true,
    })
  })

  /**
   * Every one is the latest word on that agent's journey, so the next replaces it - and only an
   * arrival, which says nothing needs doing, closes by itself.
   */
  it('files every outcome under its agent journey, and lets only an arrival fade', () => {
    const failed = pathNotice(path({ state: 'FAILED', reason: null }), 'Mason_6')
    const closest = pathNotice(path({ closest: true }), 'Mason_6')

    expect(failed).toMatchObject({ topic: 'path:6' })
    expect(closest).toMatchObject({ topic: 'path:6' })
    expect(failed).not.toHaveProperty('fade')
    expect(closest).not.toHaveProperty('fade')
  })

  it('names a column by the two numbers it has', () => {
    const notice = pathNotice(path({ state: 'ARRIVED', goal: { x: 1, y: null, z: 2 } }), 'Mason_6')
    expect(notice?.params['goal']).toBe('1, 2')
  })

  it('gives every reason the host knows its own copy', () => {
    for (const [reason, key] of Object.entries(PATH_REASONS)) {
      const notice = pathNotice(path({ state: 'FAILED', reason }), 'Mason_6')
      expect(notice, reason).toMatchObject({ kind: 'error', key })
    }
  })

  it('shows a reason it does not know in the host words rather than hiding it', () => {
    const notice = pathNotice(path({ state: 'FAILED', reason: 'a dragon ate it' }), 'Mason_6')
    expect(notice).toMatchObject({ key: 'toast.path.failedBecause', params: { reason: 'a dragon ate it' } })
    expect(pathNotice(path({ state: 'FAILED', reason: null }), 'Mason_6')?.key).toBe('toast.path.failed')
  })

  it('warns once the route is only the closest it can get, and not before', () => {
    expect(pathNotice(path({ closest: true }), 'Mason_6')).toMatchObject({ kind: 'warning', key: 'toast.path.closest' })
    expect(pathNotice(path({}), 'Mason_6')).toBeNull()
  })

  it('says nothing about a stop', () => {
    expect(pathNotice(path({ state: 'IDLE' }), 'Mason_6')).toBeNull()
  })
})

describe('what an agent leaving says', () => {
  it('tells a drop Osmium is repairing from one it is not', () => {
    const online = agent({})
    expect(agentNotice(online, agent({ state: 'LINKED', rejoining: true }), false)?.key).toBe('toast.agent.dropped')
    expect(agentNotice(online, agent({ state: 'LINKED' }), false)?.key).toBe('toast.agent.left')
  })

  it('says nothing about a Disconnect pressed in this tab', () => {
    expect(agentNotice(agent({}), agent({ state: 'LINKED' }), true)).toBeNull()
    expect(agentNotice(agent({ state: 'LINKED', rejoining: true }), agent({ state: 'LINKED' }), true)).toBeNull()
  })

  it('leaves a host going quiet to the host notice', () => {
    expect(agentNotice(agent({}), agent({ state: 'STALE', rejoining: true }), false)).toBeNull()
  })

  it('says a failure to join even when this tab asked it to join', () => {
    const notice = agentNotice(agent({ state: 'CONNECTING' }), agent({ state: 'CONNECT_FAILED' }), true)
    expect(notice).toMatchObject({ kind: 'error', key: 'toast.agent.connectFailed', params: { server: 'alpha.example:25565' } })
    expect(agentNotice(agent({}), agent({ state: 'NEEDS_RELINK' }), false)?.key).toBe('toast.agent.needsRelink')
  })

  it('says when Osmium stops trying to bring one back', () => {
    const waiting = agent({ state: 'LINKED', rejoining: true })
    expect(agentNotice(waiting, agent({ state: 'LINKED' }), false)?.key).toBe('toast.agent.gaveUp')
  })

  it('says nothing about an agent seen for the first time or one that did not change', () => {
    expect(agentNotice(undefined, agent({ state: 'CONNECT_FAILED' }), false)).toBeNull()
    expect(agentNotice(agent({}), agent({}), false)).toBeNull()
    expect(agentNotice(agent({ state: 'CONNECTING', rejoining: true }), agent({}), false)).toBeNull()
  })
})

describe('what a schematic says', () => {
  it('says a schematic it watched being read is ready, or is not', () => {
    expect(schematicNotice('ANALYSING', schematic('READY'))).toMatchObject({ kind: 'success', key: 'toast.schematic.ready' })
    expect(schematicNotice('PENDING', schematic('FAILED'))).toMatchObject({ kind: 'error', key: 'toast.schematic.failed' })
  })

  it('says nothing about one that was ready before the page opened, or was renamed', () => {
    expect(schematicNotice(undefined, schematic('READY'))).toBeNull()
    expect(schematicNotice('READY', schematic('READY'))).toBeNull()
  })
})

describe('the copy behind the notices', () => {
  /** Walks the dotted key by hand: `t` answers a missing key with the key, which would pass. */
  function copy(locale: keyof typeof LOCALES, key: string): unknown {
    return key.split('.').reduce<unknown>(
      (held, part) => (held && typeof held === 'object' ? (held as Record<string, unknown>)[part] : undefined),
      LOCALES[locale],
    )
  }

  const KEYS = [
    ...Object.values(PATH_REASONS),
    'toast.path.arrived',
    'toast.path.closest',
    'toast.path.failed',
    'toast.path.failedBecause',
    'toast.agent.dropped',
    'toast.agent.left',
    'toast.agent.connectFailed',
    'toast.agent.needsRelink',
    'toast.agent.gaveUp',
    'toast.schematic.ready',
    'toast.schematic.failed',
  ]

  it('finds nothing where there is nothing', () => {
    expect(copy('en', 'toast.path.notANotice')).toBeUndefined()
  })

  it('has every notice in every locale', () => {
    for (const locale of Object.keys(LOCALES) as Array<keyof typeof LOCALES>) {
      for (const key of KEYS) expect(copy(locale, key), `${locale} ${key}`).toEqual(expect.any(String))
    }
  })
})
