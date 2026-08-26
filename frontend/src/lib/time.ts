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
