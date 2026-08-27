import { describe, expect, it } from 'vitest'

import { captureFrom, faultIn, tokenize } from './regexHighlight'

/** The pattern a chat formatter needs, and the one every case here is really about. */
const FORMATTED = '^\\[[^\\]]+\\]\\s+([A-Za-z0-9_]{1,16}):\\s'

const kinds = (pattern: string) => tokenize(pattern).map((token) => `${token.kind}:${token.text}`)

describe('tokenize', () => {
  it('loses nothing, so the highlighting can sit behind a real input', () => {
    // The one property the whole approach rests on: the coloured layer must be the same text, or it
    // drifts out from under the caret.
    for (const pattern of [FORMATTED, '', 'plain', '^(a|b)+$', '\\d{2,}', '[]]', '[^\\]]', '(?:x)?']) {
      expect(tokenize(pattern).map((token) => token.text).join('')).toBe(pattern)
    }
  })

  it('tells the parts of a chat pattern apart', () => {
    expect(kinds('^(a)$')).toEqual(['anchor:^', 'group:(', 'literal:a', 'group:)', 'anchor:$'])
  })

  it('keeps an escape with what it escapes', () => {
    expect(kinds('\\[')).toEqual(['escape:\\['])
    expect(kinds('\\d+')).toEqual(['escape:\\d', 'quantifier:+'])
  })

  it('reads a word boundary as a position rather than an escape', () => {
    expect(kinds('\\bx')).toEqual(['anchor:\\b', 'literal:x'])
  })

  it('takes a character class whole', () => {
    expect(kinds('[A-Za-z_]')).toEqual(['class:[A-Za-z_]'])
    // `]` as the first member does not close it.
    expect(kinds('[]]')).toEqual(['class:[]]'])
    // Nor does one that is escaped.
    expect(kinds('[^\\]]')).toEqual(['class:[^\\]]'])
  })

  it('takes a counted quantifier whole', () => {
    expect(kinds('a{1,16}')).toEqual(['literal:a', 'quantifier:{1,16}'])
    expect(kinds('a{2}')).toEqual(['literal:a', 'quantifier:{2}'])
  })

  it('leaves a brace that is not a quantifier as text', () => {
    // Which is what a half-typed one is, and the box has to keep working while it is being typed.
    expect(kinds('a{')).toEqual(['literal:a{'])
    expect(kinds('a{x}')).toEqual(['literal:a{x}'])
  })

  it('runs an unclosed class to the end rather than falling over', () => {
    expect(kinds('[abc')).toEqual(['class:[abc'])
  })

  it('survives a trailing backslash', () => {
    expect(tokenize('a\\').map((t) => t.text).join('')).toBe('a\\')
  })

  it('merges runs of the same kind', () => {
    // A word is one span rather than one per letter — most of what is on the page is literals.
    expect(kinds('hello')).toEqual(['literal:hello'])
  })
})

describe('faultIn', () => {
  it('passes a pattern that can name somebody', () => {
    expect(faultIn(FORMATTED)).toBeUndefined()
    expect(faultIn('^<([A-Za-z0-9_]{1,16})> ')).toBeUndefined()
  })

  it('catches a pattern that is not one', () => {
    expect(faultIn('^([A-Za-z')).toBe('invalid')
  })

  it('catches a pattern that could never name anybody', () => {
    // Compiles, matches, names nobody — which from outside looks like the host ignoring it.
    expect(faultIn('^\\[Member\\]')).toBe('nocapture')
    // A group that captures nothing does not count.
    expect(faultIn('^(?:Member)')).toBe('nocapture')
    expect(faultIn('^(?=Member)')).toBe('nocapture')
  })

  it('says nothing about an empty box', () => {
    expect(faultIn('')).toBeUndefined()
  })
})

describe('captureFrom', () => {
  it('shows what a pattern reads out of a line', () => {
    expect(captureFrom(FORMATTED, '[Member] intemeow: test123')).toBe('intemeow')
    expect(captureFrom('^<([A-Za-z0-9_]{1,16})> ', '<Notch> hi')).toBe('Notch')
  })

  it('takes the first group that matched, as the host does', () => {
    expect(captureFrom('^(?:\\[([^\\]]+)\\] )?(\\w+): ', 'intemeow: hi')).toBe('intemeow')
  })

  it('shows nothing when the line does not match', () => {
    expect(captureFrom(FORMATTED, 'Notch joined the game')).toBeUndefined()
  })

  it('shows nothing for a pattern that cannot be used', () => {
    expect(captureFrom('^([A-Za-z', 'anything')).toBeUndefined()
  })
})

/**
 * A field can exist before its value does — binding into a settings map that has no entry yet is
 * ordinary, and every one of these runs inside a render on every keystroke. Throwing there takes the
 * page down rather than the field.
 */
describe('nothing to work with', () => {
  const nothing = [undefined, null, 0, {}] as unknown[]

  it('tokenizes it as nothing', () => {
    for (const value of nothing) expect(tokenize(value as string)).toEqual([])
  })

  it('finds no fault in it', () => {
    for (const value of nothing) expect(faultIn(value as string)).toBeUndefined()
  })

  it('reads nothing out of it', () => {
    for (const value of nothing) {
      expect(captureFrom(value as string, 'anything')).toBeUndefined()
      expect(captureFrom('(\\w+)', value as string)).toBeUndefined()
    }
  })
})
