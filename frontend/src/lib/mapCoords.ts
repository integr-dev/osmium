/**
 * Reading a place out of whatever somebody pasted.
 *
 * The point of the box this backs is that an operator has coordinates from somewhere else - F3, a
 * chat message, a ticket, another operator - and wants to look at that spot. So it takes the shapes
 * those actually arrive in rather than demanding one.
 *
 * F3 gives three numbers and the map wants two, which is the case worth being deliberate about: the
 * middle one is the height, and dropping it silently is right. Somebody pasting `192 64 208` means
 * the place, not a place at x=192, z=64.
 */

/** Somewhere to look, in block coordinates. */
export interface Place {
  x: number
  z: number
}

/**
 * The numbers in a string, in order. Handles minus signs and decimals; ignores everything else, so
 * `x=192, z=-208`, `192/-208` and `192 64 -208` all read the same way.
 */
function numbersIn(raw: string): number[] {
  return (raw.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite)
}

/**
 * Where a typed coordinate points, or null if it points nowhere.
 *
 * Two numbers are x and z. Three are x, y and z, as F3 writes them, and the height is dropped. Any
 * other count is refused rather than guessed at - one number is half an answer, and four is not a
 * coordinate at all.
 */
export function parsePlace(raw: string): Place | null {
  const found = numbersIn(raw)

  const pair =
    found.length === 2 ? [found[0]!, found[1]!]
      : found.length === 3 ? [found[0]!, found[2]!]
        : null
  if (!pair) return null

  const [x, z] = pair
  // Rounded, because a pixel is a block: fractional coordinates name a spot inside one, which is
  // below anything this map can show.
  return { x: Math.round(x!), z: Math.round(z!) }
}

/** How a place is written back out, in the form F3 shows and this box accepts. */
export function formatPlace(place: Place): string {
  return `${Math.round(place.x)}, ${Math.round(place.z)}`
}
