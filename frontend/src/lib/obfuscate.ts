import { readonly, ref, type Ref } from 'vue'

/**
 * Minecraft's obfuscated text, which scrambles rather than hides.
 *
 * Vanilla redraws each obfuscated character every frame, picking a different glyph of the same
 * width, so the run keeps its shape while nothing in it can be read. A blur says "hidden" but not
 * "this is churning", which is the part people recognise.
 *
 * **One clock for the whole page.** Every obfuscated run reads the same counter, so a feed holding
 * hundreds of lines still costs one timer - and it stops entirely when the last of them goes away,
 * rather than ticking behind a page nobody is looking at.
 */

/** Close to how often vanilla redraws. Fast enough to be unreadable, slow enough not to strobe. */
const SCRAMBLE_MS = 50

/**
 * What obfuscated characters are drawn as.
 *
 * Deliberately narrow and evenly weighted: no spaces, so word shapes cannot be inferred, and nothing
 * that reads as punctuation ending a sentence. It is the alphabet vanilla settles into for latin
 * text.
 */
const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const counter = ref(0)

/** Everything currently drawing obfuscated text. The clock runs only while this is non-empty. */
let users = 0
let timer: ReturnType<typeof setInterval> | undefined

/** Ticks while anything is being scrambled. Read it to redraw; it carries no meaning of its own. */
export const scrambleTick: Readonly<Ref<number>> = readonly(counter)

/** Starts the shared clock, or joins it. Every call must be matched by {@link release}. */
export function claim(): void {
  users += 1
  if (users > 1 || timer) return

  timer = setInterval(() => {
    // Wraps well before anything cares. It exists to change, not to count.
    counter.value = (counter.value + 1) % 1_000_000
  }, SCRAMBLE_MS)
}

/** Gives up a claim, stopping the clock once nothing is left drawing. */
export function release(): void {
  users = Math.max(0, users - 1)
  if (users > 0 || !timer) return

  clearInterval(timer)
  timer = undefined
}

/**
 * One scrambled reading of some text.
 *
 * **Shape is preserved, content is not.** The result has the same number of characters as the
 * original and keeps its spaces where they were, so a run holds its width and the line around it
 * does not move on every frame - which is the difference between text churning and a feed twitching.
 *
 * Counted in characters rather than UTF-16 units, so an emoji is replaced by one glyph rather than
 * by two halves of one.
 */
export function scramble(text: string): string {
  let out = ''

  for (const character of text) {
    // Whitespace stays. Vanilla does the same, and scrambling it would make a run visibly wider or
    // narrower than the text it stands for.
    out += /\s/.test(character) ? character : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
  }

  return out
}

/** Whether this reader has asked not to be shown movement. Obfuscated text is exactly the kind of
 * churn that setting exists for, so it falls back to something still and legible. */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true

  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
