import { describe, expect, it } from 'vitest'

import { scramble } from './obfuscate'

describe('scramble', () => {
  it('keeps the run the same length', () => {
    // Width is what stops the line twitching on every frame, and width follows character count.
    for (const text of ['hidden', 'a', 'a much longer stretch of hidden text']) {
      expect([...scramble(text)].length).toBe([...text].length)
    }
  })

  it('counts characters rather than storage units', () => {
    // An emoji is one character and must be replaced by one glyph, not by two halves of one.
    const text = '🧱🔥🧱'

    expect([...scramble(text)].length).toBe(3)
  })

  it('leaves whitespace where it was', () => {
    const scrambled = scramble('two words here')

    expect(scrambled).toMatch(/^\S{3} \S{5} \S{4}$/)
  })

  it('shows none of what it stands for', () => {
    const secret = 'password'
    // Not a proof, but a thousand draws not containing it is enough to catch a passthrough.
    const draws = Array.from({ length: 1000 }, () => scramble(secret))

    expect(draws.every((draw) => draw !== secret)).toBe(true)
  })

  it('draws something different each time', () => {
    const draws = new Set(Array.from({ length: 50 }, () => scramble('hidden')))

    // Fifty identical draws would mean it is not scrambling at all.
    expect(draws.size).toBeGreaterThan(1)
  })

  it('draws only from its own alphabet', () => {
    // Nothing from the original can leak through, including characters that would give away
    // punctuation or word endings.
    expect(scramble('secret!? 🧱 <b>')).toMatch(/^[a-zA-Z0-9]{8} [a-zA-Z0-9] [a-zA-Z0-9]{3}$/)
  })

  it('says nothing about nothing', () => {
    expect(scramble('')).toBe('')
  })
})
