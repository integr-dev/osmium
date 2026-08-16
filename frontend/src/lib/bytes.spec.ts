import { describe, expect, it } from 'vitest'
import { bytes } from './bytes'

describe('bytes', () => {
  it('climbs to the unit that keeps the number readable', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1024)).toBe('1.0 KB')
    expect(bytes(8 * 1024 * 1024)).toBe('8.0 MB')
    expect(bytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })

  it('drops the decimal once it stops meaning anything', () => {
    // The tenth of a megabyte is worth showing at 8.4 and is noise at 840.
    expect(bytes(8.4 * 1024 * 1024)).toBe('8.4 MB')
    expect(bytes(840 * 1024 * 1024)).toBe('840 MB')
  })

  it('says nothing rather than a negative size', () => {
    // An upload whose row has been rewound by the reconciler can be read before it is corrected.
    expect(bytes(-1)).toBe('0 B')
    expect(bytes(0)).toBe('0 B')
  })
})
