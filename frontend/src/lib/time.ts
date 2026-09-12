/**
 * How an instant is written down, in one place.
 *
 * Every screen had its own `toLocaleString` call and no two agreed: the audit trail carried a year,
 * the host page put the day before the month, the jobs panel did neither. Reading two of them side
 * by side made the same timestamp look like two different kinds of fact.
 *
 * Two shapes, because there are two questions. **When today** — a chat line, a telemetry sample, a
 * bar on an hourly chart — is a time, and the date would be noise on every row. **When at all** —
 * a job started, a host was seen, an operator did something — needs the day as well.
 *
 * The locale is the browser's rather than the interface's, deliberately. A timestamp is read
 * against the clock on the wall and the calendar on the desk, both of which belong to the machine.
 */

/** Hours and minutes. For anything whose date is already established by where it is drawn. */
export function atTime(at: string | number | Date): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * A day, written out, for the rule that separates one from the next in a transcript.
 *
 * Spelt rather than numeric because it appears once a day rather than once a line - there is room
 * for it, and `Tue, 26 Aug` is read at a glance where `08/26` has to be worked out. No year, for
 * the same reason {@link atShort} has none.
 */
export function onDay(at: string | number | Date): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  })
}

/**
 * Which day a moment falls on, as something cheap to compare.
 *
 * **Not a formatted date.** Deciding whether a line opens a new day is a question asked of every
 * line in the panel on every render, and `Intl` formatting is far too expensive to put there -
 * the transcript runs to thousands of rows. These are local date parts straight off the `Date`,
 * which is all a comparison needs and costs nothing; {@link onDay} formats the few that win.
 */
export function dayKey(at: string | number | Date): string {
  const on = new Date(at)

  return `${on.getFullYear()}-${on.getMonth()}-${on.getDate()}`
}

/**
 * Day, month and time. No year: everything shown this way is inside a retention window measured in
 * days, and a year on every row is four characters that never change.
 */
export function atShort(at: string | number | Date): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
