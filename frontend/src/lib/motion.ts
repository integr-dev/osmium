// `ObjectDirective` rather than `Directive`: the latter is a union with the function shorthand, and
// a caller cannot reach `updated` through it.
import type { ObjectDirective } from 'vue'

/**
 * Motion, kept to one rule: **movement marks the moment something changed, and nothing else.**
 *
 * The sidebar already refuses to show a permanent green dot, on the grounds that an indicator which
 * is always there is decoration nobody reads. Animation earns its place on the other side of that
 * line — it exists only for the instant a value becomes different, which is information an operator
 * cannot get any other way once they have looked away from the screen. Osmium is fed by a live
 * stream, so things change while nobody is watching; without this they change silently.
 *
 * Everything here is off under `prefers-reduced-motion`. See the keyframes in `src/style.css`.
 */

export function prefersReducedMotion(): boolean {
  // jsdom has no matchMedia, and a test is not a place to animate anyway.
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true
}

/**
 * `v-flash="someValue"` — tints the element for a moment whenever the bound value changes.
 *
 * Bind a primitive. Vue compares against the previous binding by identity, so an object rebuilt on
 * every render would flash on every render, which is the opposite of the point.
 *
 * Imported per component rather than registered globally: a row that flashes is a deliberate claim
 * that this particular value is worth noticing, and that is easier to keep honest when the import
 * is visible at the top of the file.
 */
export const vFlash: ObjectDirective<HTMLElement, unknown> = {
  updated(el, binding) {
    if (Object.is(binding.value, binding.oldValue)) return
    if (prefersReducedMotion()) return

    // Removed and re-added across a forced reflow, so a second change during the first animation
    // restarts it rather than being swallowed.
    el.classList.remove(FLASH_CLASS)
    void el.offsetWidth
    el.classList.add(FLASH_CLASS)
  },
}

const FLASH_CLASS = 'osmium-flash'
