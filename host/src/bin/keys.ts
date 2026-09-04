/**
 * What a keystroke means.
 *
 * Split out from the screens that use it because this is the part that can be wrong quietly: an
 * escape sequence read a byte short moves twice for one press, and a function key mistaken for a
 * bare escape backs an operator out of a form they were halfway through. None of it needs a
 * terminal to be tested against.
 */

/** Everything the screens react to. Anything else is dropped rather than guessed at. */
export type Press =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'top' }
  | { kind: 'bottom' }
  | { kind: 'enter' }
  | { kind: 'tab'; back: boolean }
  | { kind: 'cancel' }
  | { kind: 'backspace' }
  /** Printable characters, which only a form has anywhere to put. */
  | { kind: 'text'; text: string }

/**
 * Every press a chunk of input carries, in order.
 *
 * **A chunk is not a keystroke.** A held-down arrow arrives as several escape sequences in one
 * read, a fast backspace as several delete bytes, and a paste as a line of text — so a reader that
 * answered one press per chunk dropped everything after the first. Four backspaces became one.
 *
 * Escape sequences are matched whole, and an unrecognised one is skipped to its final byte rather
 * than being read as an escape followed by letters: a function key is `ESC [ 1 5 ~`, and taken
 * apart it would back an operator out of a form and then type `[15~` into whatever came next.
 *
 * A run of printable characters is one press, so a paste lands in a field in one go.
 */
export function pressesOf(chunk: Buffer | string): Press[] {
  const text = (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk).toString('utf8')
  const presses: Press[] = []

  let at = 0
  let typed = ''

  const flush = () => {
    if (!typed) return
    presses.push({ kind: 'text', text: typed })
    typed = ''
  }

  while (at < text.length) {
    const character = text[at]!

    if (character === '\u001b') {
      flush()

      const sequence = SEQUENCES.find((known) => text.startsWith(known.code, at))
      if (sequence) {
        presses.push(sequence.press())
        at += sequence.code.length
        continue
      }

      // An escape with something after it is a key this does not use. Skipped whole, rather than
      // character by character, which is how the rest of it ends up typed into a field.
      if (at + 1 < text.length) {
        let end = at + 1

        // Past the introducer first. `[` and `O` are both inside the range a final byte lives in,
        // so a scan that started at them would stop on the spot and leave `15~` to be typed.
        if (text[end] === '[' || text[end] === 'O') end += 1

        while (end < text.length && !isFinal(text[end]!)) end += 1
        at = end + 1
        continue
      }

      // A bare escape, at the end of what arrived: the terminal's own way of saying "not this".
      presses.push({ kind: 'cancel' })
      at += 1
      continue
    }

    const control = CONTROLS[character]
    if (control) {
      flush()
      presses.push(control())
      at += 1
      continue
    }

    // Anything else printable is typed. Other control bytes are dropped rather than taking the
    // paste that carried them with them.
    if (character >= ' ' && character !== '\u007f') typed += character
    at += 1
  }

  flush()
  return presses
}

/** The first press a chunk carries, for the callers that only ever get one. */
export function pressOf(chunk: Buffer | string): Press | undefined {
  return pressesOf(chunk)[0]
}

/** The escape sequences these screens use. Longest first, so a prefix cannot win. */
const SEQUENCES: Array<{ code: string; press: () => Press }> = [
  { code: '\u001b[1~', press: () => ({ kind: 'top' }) },
  { code: '\u001b[4~', press: () => ({ kind: 'bottom' }) },
  { code: '\u001b[A', press: () => ({ kind: 'up' }) },
  { code: '\u001b[B', press: () => ({ kind: 'down' }) },
  { code: '\u001b[C', press: () => ({ kind: 'right' }) },
  { code: '\u001b[D', press: () => ({ kind: 'left' }) },
  { code: '\u001b[H', press: () => ({ kind: 'top' }) },
  { code: '\u001b[F', press: () => ({ kind: 'bottom' }) },
  { code: '\u001b[Z', press: () => ({ kind: 'tab', back: true }) },
  // Application cursor mode, which a terminal switches to after `smkx`. The same four arrows.
  { code: '\u001bOA', press: () => ({ kind: 'up' }) },
  { code: '\u001bOB', press: () => ({ kind: 'down' }) },
  { code: '\u001bOC', press: () => ({ kind: 'right' }) },
  { code: '\u001bOD', press: () => ({ kind: 'left' }) },
]

/** The single bytes that are a press rather than a character. */
const CONTROLS: Record<string, (() => Press) | undefined> = {
  '\u0003': () => ({ kind: 'cancel' }),
  '\r': () => ({ kind: 'enter' }),
  '\n': () => ({ kind: 'enter' }),
  '\t': () => ({ kind: 'tab', back: false }),
  '\u007f': () => ({ kind: 'backspace' }),
  '\b': () => ({ kind: 'backspace' }),
}

/**
 * Whether a byte ends an escape sequence.
 *
 * The range CSI sequences finish in, per ECMA-48: everything from `@` to `~`. Used to skip past a
 * key these screens do not handle without having to know what it was.
 */
function isFinal(character: string): boolean {
  return character >= '@' && character <= '~'
}

/**
 * Where a highlight lands after one press, wrapping at both ends.
 *
 * Wrapping because a list this short has no scrolling to lose your place in, and pressing up at the
 * top to reach the last row is what every terminal chooser does.
 */
export function moved(active: number, press: Press | undefined, count: number): number {
  if (count === 0) return 0

  switch (press?.kind) {
    case 'up':
      return (active - 1 + count) % count
    case 'down':
      return (active + 1) % count
    case 'tab':
      return press.back ? (active - 1 + count) % count : (active + 1) % count
    case 'top':
      return 0
    case 'bottom':
      return count - 1
    default:
      return active
  }
}
