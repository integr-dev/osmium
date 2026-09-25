import { describe, expect, it } from 'vitest'
import type { JobType } from '../api/jobs'
import { agentBadge, agentDot } from './agentState'
import { JOB_FALLBACK, JOB_ICON, JOB_TINT, JOB_TYPES, jobBadge, jobDot, jobInk , oneKind } from './jobKinds'

/**
 * The colours are the point, and the thing that can silently go wrong with them is two kinds
 * ending up the same — which no screenshot review catches, because violet beside violet looks
 * exactly like one job drawn twice.
 */
describe('job kinds', () => {
  it('gives every kind its own colour, class and icon', () => {
    const tints = JOB_TYPES.map((type) => JOB_TINT[type])
    expect(new Set(tints).size).toBe(JOB_TYPES.length)

    const inks = JOB_TYPES.map(jobInk)
    expect(new Set(inks).size).toBe(JOB_TYPES.length)

    const fallbacks = JOB_TYPES.map((type) => JOB_FALLBACK[type])
    expect(new Set(fallbacks).size).toBe(JOB_TYPES.length)

    // A second signal beside the colour, for the operators who cannot use the first.
    const icons = JOB_TYPES.map((type) => JOB_ICON[type])
    expect(new Set(icons).size).toBe(JOB_TYPES.length)
  })

  it('names the variable the stylesheet defines', () => {
    expect(jobInk('EXCAVATE')).toBe('--osmium-excavating')
    expect(jobDot('MAP')).toBe('osmium-dot-mapping')
    expect(jobBadge('BUILD')).toBe('osmium-badge-building')
  })

  /** Every fallback is read into a canvas and into three.js, both of which want six hex digits. */
  it('has a usable stand-in for each, for a canvas drawn before the theme resolves', () => {
    for (const type of JOB_TYPES) expect(JOB_FALLBACK[type]).toMatch(/^#[0-9a-f]{6}$/)
  })
})

/**
 * The substitution is over `ONLINE` only. An agent that leaves the game has its pieces released, so
 * the pairing cannot outlive the session — but guarding on it anyway means a stale assignment can
 * never paint a disconnected agent as busy.
 */
describe('an agent at work', () => {
  it('takes the colour of the work it is doing', () => {
    for (const type of JOB_TYPES) {
      expect(agentDot('ONLINE', type)).toBe(jobDot(type))
      expect(agentBadge('ONLINE', type)).toBe(jobBadge(type))
    }
  })

  it('keeps its lifecycle colour when it is not in game', () => {
    expect(agentDot('STALE', 'EXCAVATE' as JobType)).not.toBe(jobDot('EXCAVATE'))
    expect(agentDot('CONNECTING', 'MAP' as JobType)).toBe(agentDot('CONNECTING'))
  })

  it('is just online when it is on nothing', () => {
    expect(agentDot('ONLINE', null)).toBe(agentDot('ONLINE'))
  })
})

/**
 * The dashboard sums across jobs, so the words have to survive the sum: a fleet raising a tower
 * while another crew charts a valley has a total that is blocks *and* columns.
 */
describe('one kind, or several', () => {
  it('is the kind when every job is that kind', () => {
    expect(oneKind(['MAP', 'MAP'])).toBe('MAP')
    expect(oneKind(['BUILD'])).toBe('BUILD')
  })

  it('is nothing at all for a mix, and for no jobs', () => {
    expect(oneKind(['BUILD', 'MAP'])).toBeNull()
    expect(oneKind([])).toBeNull()
  })
})
