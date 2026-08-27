import { describe, expect, it } from 'vitest'

import { componentsOf } from '../src/agent/chat.ts'

const LANGUAGE = {
  'chat.type.text': '<%s> %s',
  'multiplayer.player.joined': '%s joined the game',
  'commands.give.success.single': 'Gave %1$s %2$s to %3$s',
  'chat.percent': '100%% sure',
}

/** The flattened reading of a tree, for asserting that nothing was lost or reordered. */
function flatten(node: ReturnType<typeof componentsOf>): string {
  if (!node) return ''
  return node.text + (node.extra ?? []).map(flatten).join('')
}

describe('componentsOf', () => {
  it('keeps the styling a server dressed its chat in', () => {
    const tree = componentsOf(
      {
        text: '',
        extra: [
          { text: '[VIP] ', color: 'gold', bold: true },
          { text: 'Notch', color: '#55FF55' },
          { text: ': hi', color: 'white', italic: true },
        ],
      },
      LANGUAGE,
    )

    expect(flatten(tree)).toBe('[VIP] Notch: hi')
    expect(tree?.extra?.[0]).toMatchObject({ text: '[VIP] ', color: 'gold', bold: true })
    // Hex is kept, lowercased, because 1.16 servers colour by triple rather than by name.
    expect(tree?.extra?.[1]?.color).toBe('#55ff55')
    expect(tree?.extra?.[2]).toMatchObject({ italic: true })
  })

  it('resolves a translation key into the sentence it stands for', () => {
    const tree = componentsOf(
      { translate: 'chat.type.text', with: [{ text: 'Notch' }, { text: 'hello' }] },
      LANGUAGE,
    )

    expect(flatten(tree)).toBe('<Notch> hello')
  })

  it('keeps an argument styled as itself, not as the sentence', () => {
    const tree = componentsOf(
      { translate: 'multiplayer.player.joined', with: [{ text: 'Notch', color: 'yellow' }], color: 'gray' },
      LANGUAGE,
    )

    expect(flatten(tree)).toBe('Notch joined the game')
    // Style is resolved rather than inherited, so it lands on the parts that carry text: the name
    // keeps the colour it brought, and the sentence around it keeps the sentence's.
    expect(tree?.extra?.find((part) => part.text === 'Notch')?.color).toBe('yellow')
    expect(tree?.extra?.find((part) => part.text === ' joined the game')?.color).toBe('gray')
  })

  it('carries a parent style down to a child that does not mention it', () => {
    // One text-bearing node, so it arrives without a wrapper around it.
    const tree = componentsOf({ text: '', bold: true, color: 'red', extra: [{ text: 'child' }] }, LANGUAGE)

    expect(tree).toMatchObject({ text: 'child', bold: true, color: 'red' })
  })

  it('lets a child turn a parent style off', () => {
    // Minecraft's `false` is a reset, not silence. Reading it as "unmentioned" is how a rank prefix
    // ends up bolding a whole line.
    const tree = componentsOf(
      { text: '', bold: true, color: 'red', extra: [{ text: 'plain', bold: false, color: null }] },
      LANGUAGE,
    )

    expect(tree?.bold).toBeUndefined()
    expect(tree?.color).toBeUndefined()
    expect(tree?.text).toBe('plain')
  })

  it('reads numbered arguments in the order the pattern asks for', () => {
    const tree = componentsOf(
      {
        translate: 'commands.give.success.single',
        with: [{ text: '64' }, { text: 'Stone' }, { text: 'Notch' }],
      },
      LANGUAGE,
    )

    expect(flatten(tree)).toBe('Gave 64 Stone to Notch')
  })

  it('reads a doubled percent as one', () => {
    expect(flatten(componentsOf({ translate: 'chat.percent' }, LANGUAGE))).toBe('100% sure')
  })

  it('falls back to the key when nothing translates it', () => {
    // What a vanilla client shows too. Ugly, but it names the thing it could not say.
    expect(flatten(componentsOf({ translate: 'mod.thing.nobody.has' }, LANGUAGE))).toBe('mod.thing.nobody.has')
  })

  it('refuses a colour it was not expecting', () => {
    const tree = componentsOf(
      {
        text: '',
        extra: [
          { text: 'a', color: 'red; background: url(evil)' },
          { text: 'b', color: 'rgb(1,2,3)' },
          { text: 'c', color: 'javascript:alert(1)' },
          { text: 'd', color: 'dark_aqua' },
        ],
      },
      LANGUAGE,
    )

    // Validated where it becomes data, not where it becomes a document.
    expect(tree?.extra?.[0]?.color).toBeUndefined()
    expect(tree?.extra?.[1]?.color).toBeUndefined()
    expect(tree?.extra?.[2]?.color).toBeUndefined()
    expect(tree?.extra?.[3]?.color).toBe('dark_aqua')
  })

  it('drops everything interactive', () => {
    const tree = componentsOf(
      {
        text: 'click me',
        clickEvent: { action: 'open_url', value: 'https://example.invalid' },
        hoverEvent: { action: 'show_text', contents: 'boo' },
        insertion: 'typed into your chat box',
        font: 'minecraft:alt',
      },
      LANGUAGE,
    )

    expect(tree).toEqual({ text: 'click me' })
  })

  it('says nothing about an empty message', () => {
    expect(componentsOf({ text: '' }, LANGUAGE)).toBeUndefined()
    expect(componentsOf(undefined, LANGUAGE)).toBeUndefined()
    expect(componentsOf('not a component', LANGUAGE)).toBeUndefined()
  })

  it('survives a tree built to exhaust it', () => {
    let deep: Record<string, unknown> = { text: 'bottom' }
    for (let at = 0; at < 500; at++) deep = { text: 'x', extra: [deep] }

    // Cut rather than refused, and cut without running away.
    expect(() => componentsOf(deep, LANGUAGE)).not.toThrow()
    expect(flatten(componentsOf(deep, LANGUAGE)).length).toBeLessThan(500)
  })

  /**
   * Plenty of servers still write `§c§lLIKE THIS` inside a text node instead of using the component
   * fields. Left alone it reaches a browser as a literal `§c`, and the styling it describes - most
   * visibly obfuscated text - never gets applied at all.
   */
  describe('legacy section codes', () => {
    it('turns them into styling and takes them out of the text', () => {
      const tree = componentsOf({ text: '§cRed §lbold' }, LANGUAGE)

      expect(flatten(tree)).toBe('Red bold')
      expect(flatten(tree)).not.toContain('§')
      expect(tree?.extra?.[0] ?? tree).toMatchObject({ text: 'Red ', color: 'red' })
    })

    it('finds the obfuscated code, which has no other way of arriving', () => {
      const tree = componentsOf({ text: '§khidden' }, LANGUAGE)

      expect(flatten(tree)).toBe('hidden')
      expect((tree?.extra?.[0] ?? tree)?.obfuscated).toBe(true)
    })

    it('lets a colour clear the styles with it, as it does in game', () => {
      const tree = componentsOf({ text: '§lbold§athen green' }, LANGUAGE)

      const green = tree?.extra?.find((part) => part.text === 'then green')
      expect(green?.color).toBe('green')
      expect(green?.bold).toBeUndefined()
    })

    it('returns to the component style on reset, not to nothing', () => {
      // The codes sit inside a component that has styling of its own, so `§r` goes back to that.
      const tree = componentsOf({ text: '§lbold§rback', color: 'gold' }, LANGUAGE)

      const back = tree?.extra?.find((part) => part.text === 'back')
      expect(back).toMatchObject({ color: 'gold' })
      expect(back?.bold).toBeUndefined()
    })

    it('keeps a section sign that is not a code', () => {
      // A character players are allowed to type. Swallowing it would edit what somebody said.
      expect(flatten(componentsOf({ text: 'costs 50§ per' }, LANGUAGE))).toBe('costs 50§ per')
      expect(flatten(componentsOf({ text: 'trailing §' }, LANGUAGE))).toBe('trailing §')
    })

    it('reads them inside a translated sentence too', () => {
      const tree = componentsOf(
        { translate: 'multiplayer.player.joined', with: [{ text: '§bNotch' }] },
        LANGUAGE,
      )

      expect(flatten(tree)).toBe('Notch joined the game')
      expect(tree?.extra?.find((part) => part.text === 'Notch')?.color).toBe('aqua')
    })
  })

  describe('unicode', () => {
    it('carries text outside the latin range through unchanged', () => {
      const lines = ['こんにちは世界', 'Привет', 'مرحبا', '🧱🔥 building', 'é combining', '𝕮𝖆𝖑𝖑𝖎𝖌𝖗𝖆𝖕𝖍𝖞']

      for (const text of lines) {
        expect(flatten(componentsOf({ text }, LANGUAGE))).toBe(text)
      }
    })

    it('never cuts a character in half', () => {
      // Every one of these is a surrogate pair, so a cut on UTF-16 units lands inside one and leaves
      // a lone half - which is not a character and renders as a replacement glyph.
      const text = '🧱'.repeat(5000)
      const cut = flatten(componentsOf({ text }, LANGUAGE))

      expect(cut.length).toBeGreaterThan(0)
      expect(cut).toBe('🧱'.repeat([...cut].length))
      // No unpaired surrogate anywhere in the result.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false)
    })

    it('budgets by character rather than by storage unit', () => {
      // Two strings of the same character count, one of which takes twice the storage. They should
      // be cut at the same place, because a reader counts characters.
      const wide = flatten(componentsOf({ text: '🧱'.repeat(3000) }, LANGUAGE))
      const narrow = flatten(componentsOf({ text: 'a'.repeat(3000) }, LANGUAGE))

      expect([...wide].length).toBe([...narrow].length)
    })

    it('survives a lone surrogate a server sent us', () => {
      // Malformed on arrival rather than by our cutting. It must not throw, and must not be able to
      // pair with neighbouring text to form something that was never sent.
      const tree = componentsOf({ text: 'before\uD800after' }, LANGUAGE)

      expect(flatten(tree)).toContain('before')
      expect(flatten(tree)).toContain('after')
    })
  })
})
