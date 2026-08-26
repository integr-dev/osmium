// `ObjectDirective` rather than `Directive`: the latter is a union with the function shorthand, and
// a caller cannot reach `updated` through it.
import { ref, watch, type ObjectDirective, type Ref, type WatchSource } from 'vue'

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

/**
 * Which way a set of tabs was moved through.
 *
 * A panel that always arrives from the same side is a slideshow. One that arrives from the side
 * the tab is on says where in the strip you now are, which is the only thing the movement can
 * usefully carry — and going back the way you came reverses it, so the two together read as one
 * strip being scrolled rather than as a sequence of unrelated panels.
 *
 * An id the order does not contain sorts to -1, which puts it before everything. That is the right
 * answer for a tab arriving from a URL that names one this build no longer has.
 */
export function slideName<T>(order: readonly T[], from: T, to: T): string {
  return order.indexOf(to) < order.indexOf(from) ? 'panel-prev' : 'panel-next'
}

/**
 * The transition name to bind, following whatever the tab is.
 *
 * A ref rather than a computed: the direction is a fact about the *change*, and there is nothing
 * to derive it from once the change is over.
 */
export function useSlide<T>(current: WatchSource<T>, order: readonly T[]): Ref<string> {
  const name = ref('panel-next')
  watch(current, (to, from) => {
    name.value = slideName(order, from, to)
  })
  return name
}
