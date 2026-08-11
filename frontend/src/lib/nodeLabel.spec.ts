import { describe, expect, it } from 'vitest'
import { i18n } from '../i18n'
import { de } from '../i18n/de'
import { en } from '../i18n/en'
import { nodeLabel } from './nodeLabel'

describe('nodeLabel', () => {
  it('names a known node', () => {
    // Compared against the copy file, not a literal, so rewording does not break the test.
    expect(nodeLabel('fleet.chat')).toBe(en.permission['fleet.chat'])
  })

  // It bypasses t() to get past vue-i18n's dot handling, so following the locale is its own job.
  it('names it in the selected locale', () => {
    try {
      i18n.global.locale.value = 'de'
      expect(nodeLabel('fleet.chat')).toBe(de.permission['fleet.chat'])
    } finally {
      i18n.global.locale.value = 'en'
    }
  })

  // The map is presentation only. A node added on the backend must still render as something, or
  // a fresh permission would silently vanish from the account screen.
  it('falls back to the raw node when it has no label yet', () => {
    expect(nodeLabel('agent.something.new')).toBe('agent.something.new')
  })
})
