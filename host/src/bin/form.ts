import type { Press } from './keys.ts'

/**
 * A form: several fields on one screen, moved between with the arrow keys.
 *
 * **All of it at once, rather than a question at a time.** Adding a proxy is five answers that only
 * make sense together — a name, a kind, an address, a port and maybe a credential — and asked one
 * after another there is no way to look back at what you typed, no way to fix the second answer
 * without abandoning the third, and no moment where the whole thing is on screen to be checked
 * before it is written.
 *
 * Pure, deliberately. What has focus, what a keystroke does to a value, and what the screen looks
 * like are the three things that go wrong here, and none of them needs a terminal to be asked
 * about — see `form.test.ts`. What is left in `screen.ts` is raw mode and writing bytes.
 */

/** One thing being asked for. */
export interface Field {
  key: string
  label: string
  hint?: string
  /**
   * `text` is typed; `secret` is typed and shown as dots; `choice` is cycled with left and right.
   *
   * A secret is a field like any other so that a password sits in the form beside the username it
   * belongs to, rather than being a separate question after it.
   */
  kind: 'text' | 'secret' | 'choice'
  /** For a `choice`. The value is always one of these. */
  options?: string[]
  /** Shown in grey when the field is empty, and used as the value if it is left that way. */
  placeholder?: string
  value: string
}

export interface FormState {
  fields: Field[]
  active: number
  /**
   * What is wrong, from the last attempt to submit. Cleared by the next keystroke.
   *
   * Explicitly `| undefined` rather than optional: every state here is built by spreading the last
   * one and clearing this, and under `exactOptionalPropertyTypes` writing `undefined` into an
   * optional field is not the same as leaving it out.
   */
  complaint: string | undefined
}

/** What a press did to a form, and whether it is finished. */
export type FormOutcome = { state: FormState } | { done: Record<string, string> } | { cancelled: true }

export function formOf(fields: Field[]): FormState {
  return { fields, active: 0, complaint: undefined }
}

/** What the operator has entered, with placeholders standing in for anything left blank. */
export function valuesOf(state: FormState): Record<string, string> {
  return Object.fromEntries(state.fields.map((field) => [field.key, field.value || field.placeholder || '']))
}

/**
 * One keystroke against a form.
 *
 * **Enter submits from anywhere.** A form of five fields with a separate Save row is one where the
 * last thing between an operator and being finished is finding the button; enter is what every
 * terminal form does, and what is validated is the whole form rather than the field they happened
 * to be in.
 *
 * A `check` that returns a complaint keeps the form open with it shown, so a bad port is corrected
 * where it was typed rather than after the screen has been torn down.
 */
export function pressed(
  state: FormState,
  press: Press,
  check?: (values: Record<string, string>) => string | undefined,
): FormOutcome {
  const fields = state.fields
  const field = fields[state.active]
  if (!field) return { state }

  const at = (active: number): FormOutcome => ({ state: { ...state, active, complaint: undefined } })
  const edited = (value: string): FormOutcome => ({
    state: {
      ...state,
      fields: fields.map((held, index) => (index === state.active ? { ...held, value } : held)),
      // Cleared as soon as anything is typed: a complaint about the last attempt, still on screen
      // while its cause is being fixed, reads as a complaint about what is being typed now.
      complaint: undefined,
    },
  })

  switch (press.kind) {
    case 'up':
      return at((state.active - 1 + fields.length) % fields.length)
    case 'down':
      return at((state.active + 1) % fields.length)
    case 'tab':
      return at((state.active + (press.back ? -1 : 1) + fields.length) % fields.length)
    case 'top':
      return at(0)
    case 'bottom':
      return at(fields.length - 1)

    case 'left':
    case 'right': {
      // Only a choice cycles. On a text field the arrows are a cursor an operator would expect to
      // move within the value, and moving focus instead would be worse than doing nothing.
      if (field.kind !== 'choice' || !field.options?.length) return { state }

      const options = field.options
      const now = Math.max(0, options.indexOf(field.value))
      const next = press.kind === 'right' ? (now + 1) % options.length : (now - 1 + options.length) % options.length
      return edited(options[next]!)
    }

    case 'backspace':
      return field.kind === 'choice' ? { state } : edited(field.value.slice(0, -1))

    case 'text':
      return field.kind === 'choice' ? { state } : edited(field.value + press.text)

    case 'enter': {
      const values = valuesOf(state)
      const complaint = check?.(values)
      if (complaint) return { state: { ...state, complaint } }
      return { done: values }
    }

    case 'cancel':
      return { cancelled: true }

    default:
      return { state }
  }
}

/** How a value is shown: dots for a secret, the placeholder in grey for an empty field. */
export function shown(
  field: Field,
  paint: { muted: (text: string) => string },
): string {
  if (field.kind === 'secret') return field.value ? '*'.repeat(field.value.length) : paint.muted('(none)')
  if (field.value) return field.value
  return paint.muted(field.placeholder ? `${field.placeholder}` : '(empty)')
}

/**
 * The form as lines.
 *
 * Labels in a column of their own so the values line up down the page, and the focused row marked
 * with `>` as well as being reversed — the mark is what survives a terminal with no colour, and it
 * is the same mark the menus use.
 */
export function renderForm(
  state: FormState,
  paint: { accent: (text: string) => string; muted: (text: string) => string; focused: (text: string) => string; bad: (text: string) => string },
): string[] {
  const width = Math.max(...state.fields.map((field) => field.label.length))

  const lines = state.fields.flatMap((field, index) => {
    const here = index === state.active
    const mark = here ? paint.accent('>') : ' '
    const label = field.label.padEnd(width)

    // A choice says which way it moves; nothing else needs to.
    const value =
      field.kind === 'choice'
        ? `${paint.muted('<')} ${shown(field, paint)} ${paint.muted('>')}`
        : shown(field, paint)

    const row = `  ${mark} ${label}  ${here ? paint.focused(` ${value} `) : ` ${value} `}`
    return here && field.hint ? [row, `      ${paint.muted(field.hint)}`] : [row]
  })

  return state.complaint ? [...lines, '', `  ${paint.bad(state.complaint)}`] : lines
}
