import { describe, expect, it } from 'vitest'
import { atShort, atTime, dayKey, onDay } from './time'

/**
 * The locale is the machine's, so these assert shape rather than wording: that the short form
 * carries a day and the time form does not, and that both accept what the API actually sends.
 */
const AT = '2026-08-26T14:05:00Z'

describe('atTime', () => {
  it('is hours and minutes only', () => {
    expect(atTime(AT)).toMatch(/\d{1,2}[:.]\d{2}/)
    expect(atTime(AT)).not.toMatch(/2026/)
  })

  it('takes what the API sends, a number, or a date', () => {
    expect(atTime(new Date(AT))).toBe(atTime(AT))
    expect(atTime(Date.parse(AT))).toBe(atTime(AT))
  })
})

describe('onDay', () => {
  it('is the day without the time', () => {
    const written = onDay(AT)

    expect(written).toMatch(/26/)
    expect(written).not.toMatch(/\d{1,2}[:.]\d{2}/)
  })

  /** The same reasoning as atShort: everything drawn this way is inside a window of days. */
  it('leaves the year off', () => {
    expect(onDay(AT)).not.toMatch(/2026/)
  })
})

describe('dayKey', () => {
  it('is one value for a whole day and another across midnight', () => {
    const morning = dayKey(new Date(2026, 7, 26, 9, 0))
    const evening = dayKey(new Date(2026, 7, 26, 23, 59))
    const after = dayKey(new Date(2026, 7, 27, 0, 1))

    expect(morning).toBe(evening)
    expect(after).not.toBe(evening)
  })

  /** Local parts rather than UTC: the rule belongs on the reader's midnight, not on Greenwich's. */
  it('reads the day the clock on the wall would', () => {
    expect(dayKey(new Date(2026, 0, 2, 3, 4))).toBe('2026-0-2')
  })
})

describe('atShort', () => {
  it('carries the day as well as the time', () => {
    const written = atShort(AT)

    expect(written).toMatch(/\d{1,2}[:.]\d{2}/)
    expect(written).toMatch(/26/)
  })

  /** Everything drawn this way is inside a retention window measured in days. */
  it('leaves the year out', () => {
    expect(atShort(AT)).not.toMatch(/2026/)
  })
})
