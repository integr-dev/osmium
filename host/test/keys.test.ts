import { describe, expect, it } from 'vitest'

import { moved, pressesOf, pressOf } from '../src/bin/keys.ts'

/**
 * Reading a keystroke, minus the terminal.
 *
 * What goes wrong here is invisible in a screenshot and obvious in use: an escape sequence read a
 * byte short moves a list twice for one press, and a function key mistaken for a bare escape backs
 * an operator out of a form they were halfway through filling in.
 */
const ESC = '\u001b'

describe('reading a press', () => {
  it('reads both shapes of every arrow', () => {
    // What a terminal sends normally, and what one in application cursor mode sends.
    expect(pressOf(`${ESC}[A`)).toEqual({ kind: 'up' })
    expect(pressOf(`${ESC}OA`)).toEqual({ kind: 'up' })
    expect(pressOf(`${ESC}[B`)).toEqual({ kind: 'down' })
    expect(pressOf(`${ESC}OB`)).toEqual({ kind: 'down' })
    expect(pressOf(`${ESC}[D`)).toEqual({ kind: 'left' })
    expect(pressOf(`${ESC}[C`)).toEqual({ kind: 'right' })
  })

  it('reads tab forwards and shift-tab back', () => {
    expect(pressOf('\t')).toEqual({ kind: 'tab', back: false })
    expect(pressOf(`${ESC}[Z`)).toEqual({ kind: 'tab', back: true })
  })

  it('reads enter in both of the shapes a terminal sends it', () => {
    expect(pressOf('\r')).toEqual({ kind: 'enter' })
    expect(pressOf('\n')).toEqual({ kind: 'enter' })
  })

  it('reads both of the bytes a backspace key sends', () => {
    expect(pressOf('\u007f')).toEqual({ kind: 'backspace' })
    expect(pressOf('\b')).toEqual({ kind: 'backspace' })
  })

  /** A ctrl-c further into a chunk is still read; it is simply not the *first* press. */
  it('reads ctrl-c', () => {
    expect(pressOf('\u0003')).toEqual({ kind: 'cancel' })
  })

  it('treats a bare escape as backing out', () => {
    expect(pressOf(ESC)).toEqual({ kind: 'cancel' })
  })

  /**
   * The one that bites. A function key is `ESC [ 1 5 ~`, and a form that read it byte by byte would
   * see an escape - cancelling everything typed so far - and then type `[15~` into a field.
   */
  it('drops a sequence it does not use rather than reading it as an escape', () => {
    expect(pressOf(`${ESC}[15~`)).toBeUndefined()
    expect(pressOf(`${ESC}[200~`)).toBeUndefined()
  })

  it('reads printable characters as text, letters included', () => {
    expect(pressOf('a')).toEqual({ kind: 'text', text: 'a' })
    // `q` is a letter like any other now: a form has somewhere to put it, and a menu ignores it.
    expect(pressOf('q')).toEqual({ kind: 'text', text: 'q' })
    expect(pressOf('10.0.0.9')).toEqual({ kind: 'text', text: '10.0.0.9' })
  })

  it('takes a paste whole rather than a character at a time', () => {
    expect(pressOf('resi-eu-1')).toEqual({ kind: 'text', text: 'resi-eu-1' })
  })

  it('reads a buffer as readily as a string, which is what raw mode delivers', () => {
    expect(pressOf(Buffer.from(`${ESC}[A`, 'latin1'))).toEqual({ kind: 'up' })
  })
})

describe('a chunk carrying more than one press', () => {
  /**
   * The bug this was written for. A held-down key repeats faster than a read, so four backspaces
   * arrive as one chunk of four bytes - and a reader that answered one press per chunk deleted one
   * character out of four. Held arrows and pasted text are the same shape of problem.
   */
  it('reads every press in the chunk, in order', () => {
    expect(pressesOf('')).toEqual([
      { kind: 'backspace' },
      { kind: 'backspace' },
      { kind: 'backspace' },
    ])

    expect(pressesOf(`${ESC}[B${ESC}[B${ESC}[A`)).toEqual([{ kind: 'down' }, { kind: 'down' }, { kind: 'up' }])
  })

  it('keeps a run of typing together, so a paste lands in one go', () => {
    expect(pressesOf('10.0.0.9\r')).toEqual([{ kind: 'text', text: '10.0.0.9' }, { kind: 'enter' }])
  })

  it('splits typing around the keys inside it', () => {
    expect(pressesOf(`ab${ESC}[Bcd`)).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'down' },
      { kind: 'text', text: 'cd' },
    ])
  })

  /** A key these screens do not use is skipped whole, rather than typed as its own characters. */
  it('steps over an escape sequence it does not know', () => {
    expect(pressesOf(`${ESC}[15~ok`)).toEqual([{ kind: 'text', text: 'ok' }])
  })

  it('reads a bare escape at the end as backing out', () => {
    expect(pressesOf(`ab${ESC}`)).toEqual([{ kind: 'text', text: 'ab' }, { kind: 'cancel' }])
  })

  it('finds a ctrl-c wherever it is in the chunk', () => {
    expect(pressesOf('abcd')).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'cancel' },
      { kind: 'text', text: 'cd' },
    ])
  })

  it('answers with nothing for a chunk that carries nothing', () => {
    expect(pressesOf('')).toEqual([])
  })
})

describe('moving a highlight', () => {
  it('wraps at both ends, so the last row is one press from the first', () => {
    expect(moved(0, { kind: 'up' }, 4)).toBe(3)
    expect(moved(3, { kind: 'down' }, 4)).toBe(0)
  })

  it('moves one at a time otherwise', () => {
    expect(moved(1, { kind: 'up' }, 4)).toBe(0)
    expect(moved(1, { kind: 'down' }, 4)).toBe(2)
  })

  it('takes tab as forwards and shift-tab as back', () => {
    expect(moved(1, { kind: 'tab', back: false }, 4)).toBe(2)
    expect(moved(1, { kind: 'tab', back: true }, 4)).toBe(0)
  })

  it('jumps to either end', () => {
    expect(moved(2, { kind: 'top' }, 4)).toBe(0)
    expect(moved(1, { kind: 'bottom' }, 4)).toBe(3)
  })

  it('stays where it is for a press that means nothing here', () => {
    expect(moved(2, undefined, 4)).toBe(2)
    expect(moved(2, { kind: 'enter' }, 4)).toBe(2)
    expect(moved(2, { kind: 'text', text: 'a' }, 4)).toBe(2)
  })

  /** An empty list is not a state to be in, and must not answer with an index into it. */
  it('answers zero for a list with nothing in it', () => {
    expect(moved(0, { kind: 'down' }, 0)).toBe(0)
  })
})
