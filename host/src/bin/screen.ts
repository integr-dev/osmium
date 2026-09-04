import type { ReadStream } from 'node:tty'

import { pressesOf, type Press } from './keys.ts'
import { accent, bold, muted, rule, WIDTH } from './theme.ts'

/**
 * The terminal, while a wizard is running: one screen at a time, repainted in place.
 *
 * **The alternate buffer, not a wall of `clear`.** `\u001b[?1049h` swaps to a second screen the way
 * `less` and `vim` do, so what was in the terminal before is untouched and comes straight back on
 * the way out. Clearing the real screen instead would take an operator's scrollback with it — the
 * command they ran before this, and its output — to draw a menu.
 *
 * **One writer, one paint.** Every view hands over its whole list of lines and this writes them as
 * a single string, cursor home, each line cleared as it goes and the rest of the screen wiped after.
 * Painting line by line shows a half-drawn frame on a slow connection, and diffing against the last
 * frame is a lot of machinery for a screen of twelve rows.
 */

const ALTERNATE_ON = '\u001b[?1049h'
const ALTERNATE_OFF = '\u001b[?1049l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const HOME = '\u001b[H'
/** Clear from the cursor to the end of the line, and to the end of the screen. */
const TO_LINE_END = '\u001b[K'
const TO_SCREEN_END = '\u001b[J'

/** A view: what to draw, and what a keypress does to it. */
export interface View<T> {
  /** The whole screen, top to bottom. Redrawn on every press. */
  render(): string[]
  /**
   * What one press does. Returning `{ done }` closes the view with that value; returning nothing
   * leaves it open and repaints.
   */
  press(press: Press): { done: T } | undefined
}

/** Thrown when an operator backs out of a view rather than answering it. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

/**
 * Holds the alternate screen for as long as a wizard is running.
 *
 * Opened once and handed to every view, rather than swapped in and out per question: switching
 * buffers between screens makes the terminal flicker its whole contents on every step, which is
 * exactly what a wizard should not do.
 */
export class Screen {
  private held = false

  private constructor(private readonly input: ReadStream) {}

  /** Whether this terminal can be driven at all. */
  static available(): boolean {
    const input = process.stdin as ReadStream
    return process.stdin.isTTY === true && process.stdout.isTTY === true && typeof input.setRawMode === 'function'
  }

  static open(): Screen {
    const screen = new Screen(process.stdin as ReadStream)
    screen.enter()
    return screen
  }

  private enter(): void {
    if (this.held) return
    this.held = true

    process.stdout.write(ALTERNATE_ON + HIDE_CURSOR)
    // Put back however this ends: a thrown error, a ctrl-c, or the process being told to stop. A
    // terminal left on the alternate buffer with no cursor is one an operator has to reset by hand.
    process.on('exit', this.restore)
    process.on('SIGINT', this.onSignal)
    process.on('SIGTERM', this.onSignal)
  }

  /** Gives the terminal back. Safe to call twice; the second does nothing. */
  close(): void {
    if (!this.held) return
    this.held = false

    process.off('exit', this.restore)
    process.off('SIGINT', this.onSignal)
    process.off('SIGTERM', this.onSignal)
    this.restore()
  }

  private readonly restore = (): void => {
    this.input.setRawMode?.(false)
    process.stdout.write(SHOW_CURSOR + ALTERNATE_OFF)
  }

  private readonly onSignal = (): void => {
    this.close()
    process.exit(130)
  }

  /** Paints one frame. */
  paint(lines: string[]): void {
    process.stdout.write(HOME + lines.map((line) => line + TO_LINE_END).join('\n') + '\n' + TO_SCREEN_END)
  }

  /**
   * Runs a view until it is done.
   *
   * Raw mode is taken for exactly as long as the view lasts, and given back whatever ends it, so
   * anything that prints between views - a dial, a sign-in - has an ordinary terminal to print to.
   */
  async run<T>(view: View<T>): Promise<T> {
    const wasRaw = this.input.isRaw === true
    this.input.setRawMode(true)
    this.input.resume()
    this.paint(view.render())

    try {
      return await new Promise<T>((settle, fail) => {
        const finish = (value: T | undefined, err?: Error) => {
          this.input.off('data', onData)
          this.input.pause()
          if (err) fail(err)
          else settle(value as T)
        }

        const onData = (chunk: Buffer) => {
          // Every press in the chunk, in order. A held arrow key and a fast backspace both arrive
          // several to a read, and answering only the first loses the rest.
          for (const press of pressesOf(chunk)) {
            if (press.kind === 'cancel') return finish(undefined, new Cancelled())

            const outcome = view.press(press)
            if (outcome) return finish(outcome.done)
          }

          // Once, after all of them: a chunk of ten presses is one frame, not ten.
          this.paint(view.render())
        }

        this.input.on('data', onData)
      })
    } finally {
      this.input.setRawMode?.(wasRaw)
    }
  }

  /**
   * Shows something and waits.
   *
   * The counterpart to clearing the screen: output that would have scrolled past now has to be held
   * until it has been read, or a list of proxies would appear and be wiped by the next menu before
   * anybody saw it.
   */
  async page(title: string, lines: string[]): Promise<void> {
    try {
      await this.run<void>({
        render: () => [...header(title), ...lines, '', muted('  any key to go back')],
        press: () => ({ done: undefined }),
      })
    } catch (err) {
      // Escape is a key like any other here. A page asks nothing, so there is nothing to back out
      // of - and letting it throw would take the whole wizard down for a keystroke that meant
      // "yes, I have read it".
      if (!(err instanceof Cancelled)) throw err
    }
  }
}

/** The two lines every screen starts with: where you are, and a rule under it. */
export function header(title: string, subtitle?: string): string[] {
  return ['', `  ${accent('osmium')} ${bold(title)}`, ...(subtitle ? [muted(`  ${subtitle}`)] : []), rule(), '']
}

export { WIDTH }
