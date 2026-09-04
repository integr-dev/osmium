import { describe, expect, it } from 'vitest'

import { formOf, pressed, renderForm, valuesOf, type Field, type FormState } from '../src/bin/form.ts'

/**
 * The form, minus the terminal.
 *
 * Everything an operator can do to one is a pure function of the state and one press, which is the
 * whole reason it is written that way: focus that wraps the wrong way, a choice that cycles past its
 * own options, a complaint that outlives the thing it was complaining about — all of them are
 * decided here, and none of them needs a screen to be asked about.
 */
const paint = {
  accent: (text: string) => text,
  muted: (text: string) => text,
  focused: (text: string) => `[${text}]`,
  bad: (text: string) => text,
}

function fields(): Field[] {
  return [
    { key: 'name', label: 'Name', kind: 'text', value: '', placeholder: 'resi-eu-1' },
    { key: 'kind', label: 'Kind', kind: 'choice', options: ['socks5', 'socks4', 'http'], value: 'socks5' },
    { key: 'password', label: 'Password', kind: 'secret', value: '' },
  ]
}

/** Applies a run of presses, so a test reads like the keystrokes it is about. */
function after(state: FormState, ...presses: Parameters<typeof pressed>[1][]): FormState {
  return presses.reduce((held, press) => {
    const outcome = pressed(held, press)
    if (!('state' in outcome)) throw new Error('the form finished mid-run')
    return outcome.state
  }, state)
}

describe('moving between fields', () => {
  it('goes down and back up', () => {
    expect(after(formOf(fields()), { kind: 'down' }).active).toBe(1)
    expect(after(formOf(fields()), { kind: 'down' }, { kind: 'up' }).active).toBe(0)
  })

  it('wraps at both ends', () => {
    expect(after(formOf(fields()), { kind: 'up' }).active).toBe(2)
    expect(after(formOf(fields()), { kind: 'bottom' }, { kind: 'down' }).active).toBe(0)
  })

  it('takes tab and shift-tab as well', () => {
    expect(after(formOf(fields()), { kind: 'tab', back: false }).active).toBe(1)
    expect(after(formOf(fields()), { kind: 'tab', back: true }).active).toBe(2)
  })
})

describe('typing', () => {
  it('appends to the field with focus, and nowhere else', () => {
    const state = after(formOf(fields()), { kind: 'text', text: 'resi' })

    expect(state.fields[0]?.value).toBe('resi')
    expect(state.fields[1]?.value).toBe('socks5')
  })

  it('takes a paste in one go', () => {
    expect(after(formOf(fields()), { kind: 'text', text: '10.0.0.9' }).fields[0]?.value).toBe('10.0.0.9')
  })

  it('rubs out the last character', () => {
    const state = after(formOf(fields()), { kind: 'text', text: 'abc' }, { kind: 'backspace' })
    expect(state.fields[0]?.value).toBe('ab')
  })

  it('does not mind a backspace on an empty field', () => {
    expect(after(formOf(fields()), { kind: 'backspace' }).fields[0]?.value).toBe('')
  })

  /** A choice has a fixed set of answers; typing into one would make a value nothing accepts. */
  it('ignores text and backspace on a choice', () => {
    const at = { ...formOf(fields()), active: 1 }

    expect(after(at, { kind: 'text', text: 'zzz' }).fields[1]?.value).toBe('socks5')
    expect(after(at, { kind: 'backspace' }).fields[1]?.value).toBe('socks5')
  })
})

describe('a choice', () => {
  it('cycles with left and right, wrapping both ways', () => {
    const at = { ...formOf(fields()), active: 1 }

    expect(after(at, { kind: 'right' }).fields[1]?.value).toBe('socks4')
    expect(after(at, { kind: 'left' }).fields[1]?.value).toBe('http')
    expect(after(at, { kind: 'right' }, { kind: 'right' }, { kind: 'right' }).fields[1]?.value).toBe('socks5')
  })

  /**
   * On a text field the arrows are a cursor an operator expects to move within what they typed, so
   * moving focus with them instead would be worse than doing nothing.
   */
  it('leaves left and right alone on a text field', () => {
    const state = after(formOf(fields()), { kind: 'right' })

    expect(state.active).toBe(0)
    expect(state.fields[0]?.value).toBe('')
  })
})

describe('finishing', () => {
  it('hands back every value, whichever field was in focus', () => {
    const state = after(formOf(fields()), { kind: 'text', text: 'resi' }, { kind: 'down' })
    const outcome = pressed(state, { kind: 'enter' })

    expect(outcome).toEqual({ done: { name: 'resi', kind: 'socks5', password: '' } })
  })

  /** An empty field with a placeholder means what the placeholder says, which is what it showed. */
  it('takes a placeholder as the value of a field left blank', () => {
    expect(valuesOf(formOf(fields()))['name']).toBe('resi-eu-1')
  })

  it('stays open with a complaint when the check refuses', () => {
    const outcome = pressed(formOf(fields()), { kind: 'enter' }, () => 'that is not a port')

    expect(outcome).toEqual({ state: expect.objectContaining({ complaint: 'that is not a port' }) })
  })

  /**
   * A complaint about the last attempt, still on screen while its cause is being corrected, reads
   * as a complaint about what is being typed now.
   */
  it('drops the complaint as soon as anything is typed', () => {
    const refused = pressed(formOf(fields()), { kind: 'enter' }, () => 'no')
    if (!('state' in refused)) throw new Error('expected it to stay open')

    expect(after(refused.state, { kind: 'text', text: 'a' }).complaint).toBeUndefined()
    expect(after(refused.state, { kind: 'down' }).complaint).toBeUndefined()
  })

  it('says when it was backed out of', () => {
    expect(pressed(formOf(fields()), { kind: 'cancel' })).toEqual({ cancelled: true })
  })
})

describe('what it looks like', () => {
  it('marks the field with focus and only that one', () => {
    const lines = renderForm(formOf(fields()), paint)

    expect(lines[0]).toContain('>')
    expect(lines[1]?.trimStart().startsWith('>')).toBe(false)
  })

  it('lines the values up under each other', () => {
    const lines = renderForm({ ...formOf(fields()), active: 2 }, paint)
    const at = (line: string | undefined) => line?.indexOf('  ', 4)

    // Labels are padded to the widest, so every value starts in the same column.
    expect(at(lines[0])).toBe(at(lines[1]))
  })

  /** A password on screen is a password in a screenshot. */
  it('shows a secret as dots, never as itself', () => {
    const state = { ...formOf(fields()), active: 2 }
    const typed = after(state, { kind: 'text', text: 'hunter2' })
    const lines = renderForm(typed, paint)

    expect(lines.join('\n')).toContain('*******')
    expect(lines.join('\n')).not.toContain('hunter2')
  })

  it('puts the complaint under the fields', () => {
    const refused = pressed(formOf(fields()), { kind: 'enter' }, () => 'that is not a port')
    if (!('state' in refused)) throw new Error('expected it to stay open')

    expect(renderForm(refused.state, paint).at(-1)).toContain('that is not a port')
  })
})
