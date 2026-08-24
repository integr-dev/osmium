import { computed, type WritableComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQuery } from 'vue-router'

/**
 * A tab held in the URL rather than in a `ref`.
 *
 * Two screens kept this in component memory: Operations' tabs and Resources'. That cost the same
 * two things each time — neither could be linked or bookmarked, and **browser Back left the page**
 * rather than returning to the tab before it.
 *
 * **A tab, and deliberately not a step.** The schematic wizard held its step here too, and gave the
 * feature its hardest case: a URL can ask for step four, and nothing in a URL can carry the crew
 * that step four is about. The step went back into component state and the wizard restarts at the
 * top; what is left here is the case this suits, where every value is one the screen can honour on
 * arrival.
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
