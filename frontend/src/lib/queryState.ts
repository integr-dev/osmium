import { computed, type WritableComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQuery } from 'vue-router'

/**
 * A tab or a step held in the URL rather than in a `ref`.
 *
 * Three screens kept this state in component memory: Operations' three tabs, Resources' three, and
 * the four-step schematic pipeline. That cost the same three things every time. Nothing could be
 * linked or bookmarked; a reload always dropped the operator back on the first tab at step one; and
 * **browser Back left the page entirely** rather than stepping back — at the one moment in the app
 * where Back is most likely to be pressed, part way through a wizard.
 *
 * A query parameter rather than a nested route. These are panels within one screen, not screens of
 * their own: the page keeps its header, its node gate and its loaded fleet across a tab change, and
 * modelling that as a route would mean restructuring the router to describe something that is not a
 * navigation.
 *
 * The route is the **only** source of truth. Reading follows it, so Back and Forward work with no
 * listener of ours, and writing pushes, so each change is its own history entry.
 */
export function useQueryTab<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): WritableComputedRef<T> {
  const route = useRoute()
  const router = useRouter()

  const read = (): T => readTab(route.query, key, allowed, fallback)

  return computed<T>({
    get: read,
    set(value) {
      if (value === read()) return
      void router.push({ query: withParam(route.query, key, value === fallback ? null : value) })
    },
  })
}

/**
 * The same thing for a value with no fixed set — an id, say — kept as a string or null.
 *
 * Separate from [useQueryTab] rather than folded into it with an optional `allowed`, because the
 * two differ in what they promise: that one always returns a member of a known set, and this one
 * returns whatever was in the URL. A caller has to know which it is holding.
 *
 * **Replaces rather than pushes.** A tab or a step is a move an operator made and expects Back to
 * undo; picking which schematic to look at refines the view they are already on. Pushing it would
 * mean Back walked through every row they had clicked before it reached the step they wanted, which
 * is the version of history nobody asked for. Replacing still survives a reload and still travels
 * in a shared link — it simply does not stack.
 */
export function useQueryValue(key: string): WritableComputedRef<string | null> {
  const route = useRoute()
  const router = useRouter()

  const read = (): string | null => {
    const raw = route.query[key]
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }

  return computed<string | null>({
    get: read,
    set(value) {
      if (value === read()) return
      void router.replace({ query: withParam(route.query, key, value) })
    },
  })
}

/**
 * Which member of [allowed] a query says, or [fallback].
 *
 * Exported for its own test. Anything at all can be typed into a query string, and an unrecognised
 * value must not leave a page rendering nothing — so this narrows to the known set rather than
 * trusting what it is handed. Arrays arrive when a parameter is repeated (`?tab=a&tab=b`), which is
 * equally not a tab.
 */
export function readTab<T extends string>(
  query: LocationQuery,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = query[key]
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback
}

/**
 * The query with one parameter set, or removed when null.
 *
 * The rest is carried through: a page can hold more than one of these, and the dashboard's `denied`
 * notice is not a tab component's to throw away. Removing rather than writing an empty value keeps
 * a default out of the address bar, where it would say nothing and only add length.
 */
export function withParam(
  query: LocationQuery,
  key: string,
  value: string | null,
): LocationQuery {
  const next = { ...query }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}
