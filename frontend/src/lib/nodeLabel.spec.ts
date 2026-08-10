import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { nodeLabel } from './nodeLabel'

describe('nodeLabel', () => {
  it('names a known node', () => {
    // Compared against the copy file, not a literal, so rewording does not break the test.
    expect(nodeLabel('fleet.chat')).toBe(en.permission['fleet.chat'])
  })

  // The map is presentation only. A node added on the backend must still render as something, or
  // a fresh permission would silently vanish from the account screen.
  it('falls back to the raw node when it has no label yet', () => {
    expect(nodeLabel('agent.something.new')).toBe('agent.something.new')
  })
})
