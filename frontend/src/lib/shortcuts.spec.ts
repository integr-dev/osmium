import { describe, expect, it, vi } from 'vitest'
import { isShortcut, shortcutLabel } from './shortcuts'

function onPlatform(userAgent: string): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
}

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

describe('what the interface prints', () => {
  it('spells it the way the machine reading it does', () => {
    onPlatform(MAC)
    expect(shortcutLabel('K')).toBe('⌘K')

    onPlatform(WINDOWS)
    expect(shortcutLabel('K')).toBe('Ctrl K')
  })
})

describe('what the handler accepts', () => {
  const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

  it('takes either modifier, whatever the platform', () => {
    // A Mac keyboard on a Linux box still sends Ctrl.
    expect(isShortcut(press({ key: 'k', ctrlKey: true }), 'K')).toBe(true)
    expect(isShortcut(press({ key: 'k', metaKey: true }), 'K')).toBe(true)
  })

  it('needs a modifier', () => {
    expect(isShortcut(press({ key: 'k' }), 'K')).toBe(false)
  })

  /** Caps lock, or a held shift, must not silently turn the shortcut off. */
  it('ignores the case of the key', () => {
    expect(isShortcut(press({ key: 'K', ctrlKey: true }), 'k')).toBe(true)
  })

  it('does not answer for a different key', () => {
    expect(isShortcut(press({ key: 'j', ctrlKey: true }), 'K')).toBe(false)
  })
})
