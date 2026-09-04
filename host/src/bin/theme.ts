/**
 * How `osmium-link` looks: Osmium's own palette, at a terminal.
 *
 * The interface is green on a dark ground with amber for "in flight" and red for "wrong", and the
 * marks it puts on things are shapes rather than pictures. A command-line tool for the same
 * deployment reading like a different product is a small thing that adds up, so the colours here are
 * the tokens the frontend uses, matched to the nearest of the 256 a terminal can be relied on for.
 *
 * **ASCII only.** No emoji and no box drawing: this runs over SSH, inside containers, in CI logs and
 * in whatever terminal a host happens to have, and half of those render a glyph outside the first
 * 128 as a box or as two columns of nothing. `[+]` says the same thing everywhere.
 *
 * **Everything here builds a string.** The full-screen views need lines to paint rather than output
 * to print — a screen is repainted on every keypress, and anything that wrote as it went would
 * scroll the frame it is part of. Only {@link say} prints, and only the flag-driven commands use it.
 *
 * **Colour is decoration and never information.** Every line reads the same with it stripped, which
 * is what makes honouring `NO_COLOR` free rather than a degraded mode.
 */

/**
 * Whether to paint at all.
 *
 * `NO_COLOR` is the convention and is honoured whatever it is set to; `FORCE_COLOR` is the other
 * half of it, for a pipe that is going somewhere that does understand escapes. Otherwise it is on
 * exactly when stdout is a terminal, because anything else is a log file with escape codes in it.
 */
function painting(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false
  if (process.env['FORCE_COLOR'] !== undefined) return true
  return process.stdout.isTTY === true
}

/** The 256-colour approximations of the interface's own tokens. */
const INK = {
  /** `--color-primary`, the green everything of ours is drawn in. */
  primary: 107,
  /** `--color-warning`: in flight, or waiting on somebody. */
  warning: 179,
  /** `--color-error`, and the colour of a stranger on the map. */
  error: 167,
  /** The muted body text a hint is written in. */
  muted: 245,
} as const

type Ink = keyof typeof INK

function paint(ink: Ink, text: string): string {
  return painting() ? `\u001b[38;5;${INK[ink]}m${text}\u001b[0m` : text
}

export const accent = (text: string): string => paint('primary', text)
export const warn = (text: string): string => paint('warning', text)
export const bad = (text: string): string => paint('error', text)
export const muted = (text: string): string => paint('muted', text)
export const bold = (text: string): string => (painting() ? `\u001b[1m${text}\u001b[0m` : text)

/**
 * What has focus, drawn in reverse video.
 *
 * With no colour it falls back to brackets rather than to nothing: which field a keystroke is about
 * to land in is information, not decoration, and it is the one thing on these screens that must
 * survive `NO_COLOR`.
 */
export const focused = (text: string): string => (painting() ? `\u001b[7m${text}\u001b[27m` : `[${text}]`)

/**
 * The marks, which carry meaning and so are named for what they mean rather than what they look
 * like. All ASCII, and none wider than four columns, so a stack of them lines up.
 */
export const MARK = {
  /** Something was added. */
  added: '[+]',
  /** Something was removed. */
  removed: '[-]',
  /** It worked. */
  ok: '[ok]',
  /** It did not. */
  failed: '[!!]',
  /** Worth reading, and not a failure. */
  note: '[*]',
  /** Waiting on somebody: an approval, a dial, a server. */
  waiting: '[~]',
  /** What the operator is being asked. */
  prompt: '[>]',
} as const

/** How wide a screen is laid out. Rules and padding measure against this. */
export const WIDTH = 74

/** The rule under a heading, or between sections. */
export function rule(): string {
  return muted('  ' + '-'.repeat(WIDTH))
}

/** A heading for the flag-driven commands, which print rather than paint. */
export function heading(title: string, subtitle?: string): string[] {
  return ['', `  ${accent('osmium')} ${bold(title)}`, ...(subtitle ? [muted(`  ${subtitle}`)] : []), rule(), '']
}

export const added = (text: string): string => `  ${accent(MARK.added)} ${text}`
export const removed = (text: string): string => `  ${warn(MARK.removed)} ${text}`
export const ok = (text: string): string => `  ${accent(MARK.ok)} ${text}`
export const failed = (text: string): string => `  ${bad(MARK.failed)} ${text}`
export const waiting = (text: string): string => `  ${warn(MARK.waiting)} ${text}`

/** An aside: true, worth reading, and not the answer to anything. */
export const note = (text: string): string => `  ${muted(MARK.note)} ${muted(text)}`

/** A table, sized to its own contents rather than to guessed column widths. */
export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )

  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()

  return [muted(`  ${line(headers)}`), ...rows.map((row) => `  ${line(row)}`)]
}

/** Prints. The flag-driven commands do this with what they built; the screens paint instead. */
export function say(line = ''): void {
  process.stdout.write(`${line}\n`)
}
