import { formOf, pressed, renderForm, type Field } from './form.ts'
import { moved } from './keys.ts'
import { header, type Screen } from './screen.ts'
import { accent, bad, focused, muted } from './theme.ts'

/**
 * The screens themselves: a menu, a form, and a yes-or-no.
 *
 * Each is a whole screen rather than a line at the bottom of one, which is the point of the
 * alternate buffer: what an operator is being asked is the only thing in front of them, and the
 * answer to the last question is not still sitting above it competing for attention.
 */

export interface Option<T> {
  label: string
  value: T
  hint?: string
}

/** The rows of a menu, marked at the one with focus. Pure, so the layout can be asked about. */
export function menuLines<T>(options: Array<Option<T>>, active: number): string[] {
  return options.map((option, at) => {
    const here = at === active
    const mark = here ? accent('>') : ' '
    const label = here ? focused(` ${option.label} `) : ` ${option.label} `
    const hint = option.hint ? muted(`  ${option.hint}`) : ''

    return `  ${mark} ${label}${hint}`
  })
}

/** One of a list, moved through with the arrows. */
export async function menu<T>(
  screen: Screen,
  title: string,
  question: string,
  options: Array<Option<T>>,
): Promise<T> {
  if (options.length === 0) throw new Error('nothing to choose from')

  let active = 0

  return screen.run<T>({
    render: () => [
      ...header(title),
      `  ${question}`,
      '',
      ...menuLines(options, active),
      '',
      muted('    arrows to move, enter to choose, esc to go back'),
    ],
    press: (press) => {
      if (press.kind === 'enter') return { done: options[active]!.value }

      active = moved(active, press, options.length)
      return undefined
    },
  })
}

/**
 * Several answers at once, moved between with the arrows.
 *
 * `check` is given every value each time enter is pressed, and what it returns is shown under the
 * form rather than thrown: a port that is not a port is corrected where it was typed.
 */
export async function form(
  screen: Screen,
  title: string,
  fields: Field[],
  check?: (values: Record<string, string>) => string | undefined,
): Promise<Record<string, string>> {
  let state = formOf(fields)

  return screen.run<Record<string, string>>({
    render: () => [
      ...header(title),
      ...renderForm(state, { accent, muted, focused, bad }),
      '',
      muted('    arrows to move, left/right to change a choice, enter to save, esc to cancel'),
    ],
    press: (press) => {
      const outcome = pressed(state, press, check)

      if ('done' in outcome) return { done: outcome.done }
      if ('cancelled' in outcome) return undefined

      state = outcome.state
      return undefined
    },
  })
}

/** Yes or no, as a menu of two, so there is one way to answer anything here. */
export async function confirm(screen: Screen, title: string, question: string): Promise<boolean> {
  return menu<boolean>(screen, title, question, [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
  ])
}
