import { describe, expect, it } from 'vitest'
import { atShort, atTime } from './time'

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
