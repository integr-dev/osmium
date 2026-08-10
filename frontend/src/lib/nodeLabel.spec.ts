import { describe, expect, it } from 'vitest'
import { nodeLabel } from './nodeLabel'

describe('nodeLabel', () => {
  it('names a known node', () => {
    expect(nodeLabel('agent.chat')).toBe('Speak in game as a bot')
  })

  // The map is presentation only. A node added on the backend must still render as something, or
  // a fresh permission would silently vanish from the account screen.
  it('falls back to the raw node when it has no label yet', () => {
    expect(nodeLabel('agent.something.new')).toBe('agent.something.new')
  })
})
