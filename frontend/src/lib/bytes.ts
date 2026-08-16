/**
 * File sizes, for people rather than for machines.
 *
 * Shared because an upload is watched in two places at once — the dialog that started it and the
 * row in the library — and two formatters would eventually disagree about the same file mid-transfer.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * One decimal below ten, none above it.
 *
 * A schematic goes from `8.4 MB` to `840 MB`, and carrying the same precision across that range
 * gives either `840.3 MB`, where the tenth is noise, or `8 MB`, where a fifth of the file has
 * disappeared into the rounding. Bytes get no decimal at all: there is no such thing as half a byte.
 */
export function bytes(count: number): string {
  let value = Math.max(0, count)
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`
}
