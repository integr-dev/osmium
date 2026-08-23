import { describe, expect, it } from 'vitest'
import { readTab, withParam } from './queryState'

/**
 * Moving a tab out of a `ref` and into the URL hands its value to anyone who can type in an address
 * bar. These two functions are where that untrusted string is made safe, and where the *rest* of the
 * query survives being written to — neither of which a type checker can see.
 */
const TABS = ['bots', 'hosts', 'graph'] as const

describe('reading a tab out of a query', () => {
  it('takes a value that is one of the tabs', () => {
    expect(readTab({ tab: 'hosts' }, 'tab', TABS, 'bots')).toBe('hosts')
  })

  it('falls back rather than rendering nothing', () => {
    // The whole hazard of putting this in the URL: an unrecognised value must not leave a page with
    // every panel switched off.
    expect(readTab({ tab: 'nonsense' }, 'tab', TABS, 'bots')).toBe('bots')
    expect(readTab({}, 'tab', TABS, 'bots')).toBe('bots')
    expect(readTab({ tab: null }, 'tab', TABS, 'bots')).toBe('bots')
  })

  it('falls back for a repeated parameter, which arrives as an array', () => {
    // `?tab=bots&tab=hosts` is a real thing a link can contain, and it is not a tab.
    expect(readTab({ tab: ['bots', 'hosts'] }, 'tab', TABS, 'bots')).toBe('bots')
  })

  it('is case-sensitive, because the values are ids rather than prose', () => {
    expect(readTab({ tab: 'Hosts' }, 'tab', TABS, 'bots')).toBe('bots')
  })
})

describe('writing one parameter', () => {
  it('leaves the rest of the query alone', () => {
    // Operations holds a tab, a step and a schematic at once, and the dashboard's `denied` notice is
    // not a tab component's to throw away.
    expect(withParam({ tab: 'schematics', schematic: '91' }, 'step', 'plan')).toEqual({
      tab: 'schematics',
      schematic: '91',
      step: 'plan',
    })
  })

  it('removes the key on null rather than writing an empty value', () => {
    expect(withParam({ tab: 'hosts', step: 'plan' }, 'step', null)).toEqual({ tab: 'hosts' })
  })

  it('does not mutate the query it was given', () => {
    // It is handed `route.query`, which is the router's own object.
    const query = { tab: 'hosts' }
    withParam(query, 'step', 'plan')
    expect(query).toEqual({ tab: 'hosts' })
  })
})
