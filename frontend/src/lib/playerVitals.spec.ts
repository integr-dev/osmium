import { describe, expect, it } from 'vitest'
import { heartsLabel, playerVitals } from './vitals'

/**
 * The one-line reading for somebody standing near an agent.
 *
 * Shared by four screens, which is the reason it is worth pinning: the failure it prevents is the
 * same player being described two different ways on two screens at once, and that is invisible
 * from any one of them.
 */
describe('heartsLabel', () => {
  it('writes a whole number without a decimal', () => {
    expect(heartsLabel(20)).toBe('20/20 hp')
  })

  it('keeps a half heart', () => {
    // The difference between one hit from dead and two, and the smallest state the game has.
    expect(heartsLabel(0.5)).toBe('0.5/20 hp')
  })

  it('rounds to the nearest half rather than to the nearest whole', () => {
    expect(heartsLabel(18.4)).toBe('18.5/20 hp')
    expect(heartsLabel(18.1)).toBe('18/20 hp')
  })

  it('does not cap at twenty', () => {
    // A health boost is real, and reporting somebody as easier to kill than they are is worse than
    // an unfamiliar number.
    expect(heartsLabel(30)).toBe('30/20 hp')
  })

  it('has nothing to say when the server said nothing', () => {
    expect(heartsLabel(null)).toBeNull()
    expect(heartsLabel(undefined)).toBeNull()
  })

  it('refuses a reading that cannot be one', () => {
    expect(heartsLabel(-1)).toBeNull()
    expect(heartsLabel(Number.NaN)).toBeNull()
  })
})

describe('playerVitals', () => {
  it('leads with health, which is the field being scanned for', () => {
    expect(playerVitals({ health: 12, ping: 84, gamemode: 1 })).toBe('12/20 hp · 84ms · creative')
  })

  it('drops what the server did not say rather than padding the line', () => {
    expect(playerVitals({ health: null, ping: 84, gamemode: null })).toBe('84ms')
  })

  it('says nothing at all about a player the server described in no way', () => {
    expect(playerVitals({})).toBe('')
  })

  it('leaves survival unnamed, since it is what almost everyone is', () => {
    expect(playerVitals({ health: 20, gamemode: 0 })).toBe('20/20 hp')
  })

  it('keeps a ping of zero, which is a reading rather than an absence', () => {
    expect(playerVitals({ ping: 0 })).toBe('0ms')
  })
})
