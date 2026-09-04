import { afterEach, describe, expect, it } from 'vitest'

import { accent, bad, MARK, muted, table, warn } from '../src/bin/theme.ts'

/**
 * How the command line looks.
 *
 * Two rules, and both are about where this runs rather than about taste. It runs over SSH, in
 * containers and in CI logs, so every glyph is plain ASCII — anything above 127 is a box or a
 * double-width smear in half the terminals a host actually has. And colour is decoration only, so a
 * pipe, a log file or `NO_COLOR` loses nothing but the paint.
 */
const painted = /\[[0-9;]*m/

const held = { ...process.env }

afterEach(() => {
  process.env['NO_COLOR'] = held['NO_COLOR']
  process.env['FORCE_COLOR'] = held['FORCE_COLOR']
  if (held['NO_COLOR'] === undefined) delete process.env['NO_COLOR']
  if (held['FORCE_COLOR'] === undefined) delete process.env['FORCE_COLOR']
})

describe('the marks', () => {
  it('are ASCII, so every terminal draws them', () => {
    for (const [name, mark] of Object.entries(MARK)) {
      // Printable ASCII only: no emoji, no box drawing, nothing that needs a font.
      expect(mark, name).toMatch(/^[\x20-\x7e]+$/)
    }
  })

  /** A mark carries the meaning, so it must survive the colour being stripped. */
  it('say what they mean without any colour', () => {
    expect(MARK.added).toBe('[+]')
    expect(MARK.removed).toBe('[-]')
    expect(MARK.ok).toBe('[ok]')
    expect(MARK.failed).toBe('[!!]')
  })
})

describe('colour', () => {
  it('is off when NO_COLOR is set, whatever it is set to', () => {
    process.env['NO_COLOR'] = ''
    delete process.env['FORCE_COLOR']

    expect(accent('osmium')).toBe('osmium')
    expect(warn('careful')).toBe('careful')
    expect(bad('no')).toBe('no')
    expect(muted('aside')).toBe('aside')
  })

  it('is on when FORCE_COLOR is set, for a pipe that understands it', () => {
    delete process.env['NO_COLOR']
    process.env['FORCE_COLOR'] = '1'

    expect(accent('osmium')).toMatch(painted)
    // And the text is still in there, which is what makes stripping it lossless.
    expect(accent('osmium')).toContain('osmium')
  })

  /** NO_COLOR wins: it is the one an operator sets deliberately about their own terminal. */
  it('lets NO_COLOR beat FORCE_COLOR', () => {
    process.env['NO_COLOR'] = '1'
    process.env['FORCE_COLOR'] = '1'

    expect(accent('osmium')).toBe('osmium')
  })
})

describe('a table', () => {
  it('sizes its columns to what is in them', () => {
    process.env['NO_COLOR'] = '1'

    const lines = table(
      ['NAME', 'KIND'],
      [
        ['a-very-long-proxy-name', 'socks5'],
        ['b', 'http'],
      ],
    )

    expect(lines).toHaveLength(3)

    // The header is padded to the widest cell under it, so every row's second column starts where
    // the heading does. Asserted against each other rather than against a counted number of spaces:
    // the invariant is that they line up, not that the indent is any particular width.
    expect(lines[0]?.indexOf('KIND')).toBe(lines[1]?.indexOf('socks5'))
    expect(lines[0]?.indexOf('KIND')).toBe(lines[2]?.indexOf('http'))
    expect(lines[2]?.trimEnd()).toBe(lines[2])
  })

  /** Every line is built rather than printed, because a screen is painted whole. */
  it('prints nothing itself', () => {
    process.env['NO_COLOR'] = '1'

    let printed = 0
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => {
      printed += 1
      return true
    }) as typeof process.stdout.write

    try {
      table(['NAME'], [['a']])
    } finally {
      process.stdout.write = write
    }

    expect(printed).toBe(0)
  })
})
