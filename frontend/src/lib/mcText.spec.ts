import { describe, expect, it } from 'vitest'

import { runsOf } from './mcText'

const said = (components: unknown) =>
  runsOf(components)
    .map((run) => run.text)
    .join('')

describe('runsOf', () => {
  it('says nothing when there is no tree, so the plain line is drawn instead', () => {
    expect(runsOf(undefined)).toEqual([])
    expect(runsOf(null)).toEqual([])
    expect(runsOf('a string')).toEqual([])
    expect(runsOf({ text: '' })).toEqual([])
  })

  it('flattens a tree in reading order', () => {
    const runs = runsOf({
      text: '',
      extra: [{ text: '[VIP] ' }, { text: 'Notch' }, { text: ': hi' }],
    })

    expect(runs.map((run) => run.text)).toEqual(['[VIP] ', 'Notch', ': hi'])
  })

  it('gives each run the style it was sent with', () => {
    const runs = runsOf({
      text: '',
      extra: [
        { text: 'loud', bold: true },
        { text: 'quiet', italic: true },
        { text: 'gone', strikethrough: true },
        { text: 'hidden', obfuscated: true },
        { text: 'marked', underlined: true },
      ],
    })

    expect(runs[0]).toMatchObject({ text: 'loud', bold: true, italic: false })
    expect(runs[1]).toMatchObject({ italic: true })
    expect(runs[2]).toMatchObject({ strikethrough: true })
    expect(runs[3]).toMatchObject({ obfuscated: true })
    expect(runs[4]).toMatchObject({ underlined: true })
  })

  /**
   * Inheritance is the host's job, not this one's.
   *
   * Minecraft's rules are subtle - a child inherits what it does not mention, an explicit `false` is
   * a reset rather than silence, and a `§` colour code clears the styles beside it. The host has the
   * whole tree and settles all of it, stamping each node with the style it ends up with. Resolving
   * it again here would be a second chance to get it wrong on a tree already decided.
   */
  it('reads each node as it was sent, without inheriting', () => {
    const runs = runsOf({
      text: 'parent',
      color: 'red',
      bold: true,
      extra: [{ text: 'child' }, { text: 'other', color: 'gold', bold: true }],
    })

    expect(runs[0]).toMatchObject({ text: 'parent', color: '#ff5555', bold: true })
    // Says nothing, so it is nothing. The host would have stamped it had it meant to inherit.
    expect(runs[1]).toMatchObject({ text: 'child', bold: false })
    expect(runs[1]?.color).toBeUndefined()
    expect(runs[2]).toMatchObject({ text: 'other', color: '#ffaa00', bold: true })
  })

  describe('colour', () => {
    it('maps the vanilla names to their canonical hex', () => {
      expect(runsOf({ text: 'a', color: 'dark_purple' })[0]?.color).toBe('#aa00aa')
      expect(runsOf({ text: 'a', color: 'aqua' })[0]?.color).toBe('#55ffff')
    })

    it('leaves black and white to the theme', () => {
      // The two that vanish when the viewer's theme is the same colour. An unreadable line is worse
      // than a slightly wrong one.
      expect(runsOf({ text: 'a', color: 'black' })[0]?.color).toBeUndefined()
      expect(runsOf({ text: 'a', color: 'white' })[0]?.color).toBeUndefined()
    })

    it('takes a hex triple, since servers colour by value', () => {
      expect(runsOf({ text: 'a', color: '#55FF55' })[0]?.color).toBe('#55ff55')
    })

    it('refuses anything else, because this reaches a style attribute', () => {
      const hostile = [
        'red; background: url(https://example.invalid/pixel)',
        'rgb(1,2,3)',
        'javascript:alert(1)',
        'var(--anything)',
        '#fff',
        '#gggggg',
        'expression(alert(1))',
        42,
        { toString: () => 'red' },
      ]

      for (const color of hostile) {
        expect(runsOf({ text: 'a', color })[0]?.color).toBeUndefined()
      }
    })
  })

  describe('hostile input', () => {
    it('cuts a tree built to go on forever', () => {
      let deep: Record<string, unknown> = { text: 'bottom' }
      for (let at = 0; at < 5000; at++) deep = { text: 'x', extra: [deep] }

      expect(() => runsOf(deep)).not.toThrow()
      expect(runsOf(deep).length).toBeLessThanOrEqual(256)
    })

    it('cuts a tree built to go on sideways', () => {
      const wide = { text: '', extra: Array.from({ length: 5000 }, () => ({ text: 'x' })) }

      expect(runsOf(wide).length).toBeLessThanOrEqual(256)
    })

    it('steps over rubbish among the children rather than falling over it', () => {
      const runs = runsOf({ text: '', extra: [{ text: 'a' }, null, 'nope', 7, { text: 'b' }] })

      expect(runs.map((run) => run.text)).toEqual(['a', 'b'])
    })

    it('keeps markup as text, never as markup', () => {
      // It reaches the page through a text node, so this is only asserting it is carried whole and
      // unescaped - the escaping is the renderer's, and doing it here too would double it.
      expect(said({ text: '<img src=x onerror=alert(1)>' })).toBe('<img src=x onerror=alert(1)>')
    })
  })

  describe('unicode', () => {
    it('carries text outside the latin range through unchanged', () => {
      for (const text of ['こんにちは', 'Привет', 'مرحبا', '🧱🔥', '𝕮𝖆𝖑𝖑𝖎']) {
        expect(said({ text })).toBe(text)
      }
    })

    it('keeps characters whole across a run boundary', () => {
      // The halves of one emoji, split across two runs by the server. Joined back up they are the
      // character again - nothing here may reorder or drop either half.
      const runs = runsOf({ text: '', extra: [{ text: 'a🧱' }, { text: '🔥b' }] })

      expect(runs.map((run) => run.text).join('')).toBe('a🧱🔥b')
    })
  })
})
