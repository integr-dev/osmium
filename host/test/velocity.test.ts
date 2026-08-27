import { describe, expect, it } from 'vitest'

import { absoluteVelocity } from '../src/agent/bot.ts'

/**
 * The workaround this guards is version-dependent, and gets it exactly backwards if the answer
 * changes underneath it: correcting a version that does not need it divides knockback by eight
 * thousand just as surely as not correcting one that does.
 */
describe('absoluteVelocity', () => {
  it('is false while entity velocity is three shorts', () => {
    expect(absoluteVelocity('1.20.4')).toBe(false)
    expect(absoluteVelocity('1.21.1')).toBe(false)
    // The last version before the field changed.
    expect(absoluteVelocity('1.21.8')).toBe(false)
  })

  it('is true from the version that made it a quantised vector', () => {
    expect(absoluteVelocity('1.21.9')).toBe(true)
    expect(absoluteVelocity('1.21.11')).toBe(true)
    expect(absoluteVelocity('26.1')).toBe(true)
  })

  it('leaves mineflayer alone when it cannot tell', () => {
    // Not a version anything knows. Doing nothing is right: mineflayer's own scaling is correct
    // everywhere before 1.21.9, so the conservative answer is also the one that was true for longer.
    expect(absoluteVelocity('9.9.9')).toBe(false)
  })
})
