import { watch } from 'vue'
import { apiBaseUrl } from '../api/base'
import { token } from '../api/token'

/**
 * Player skins, fetched with the access token and normalised to the modern layout.
 *
 * The same bargain as `avatars.ts` and for the same reason: `/api/avatars/{id}/skin` is gated, and
 * neither an `<img src>` nor three's texture loader can send an `Authorization` header. What comes
 * back here is a canvas rather than a URL, because a legacy skin has to be redrawn before anything
 * can wrap it around a model.
 *
 * **Legacy skins are not a rarity to defend against; they are ordinary.** Of the three accounts this
 * was first checked against, two came back 64x32 — the pre-1.8 layout, which has no second layer and
 * only one arm and one leg, the other side being mirrored at render time. The model's UVs point at
 * the bottom half of a 64x64 sheet, so an unconverted legacy skin renders a player with transparent
 * limbs. The skin service does not normalise, so this does.
 */

/** The modern sheet. A skin that is not this or the legacy half-height is not one this can use. */
const WIDTH = 64
const HEIGHT = 64

/**
 * One face of a limb, copied from the side a legacy skin has to the side it does not.
 *
 * **Mirrored, not simply moved.** The game draws a legacy skin's left limb as the right one seen in
 * a mirror, so the faces swap sides as they cross: what was the outer face becomes the inner one.
 * Copying the block across unflipped is close enough that most skins look right and wrong exactly
 * where anybody notices — a stripe down one arm ends up on the wrong side of the other.
 *
 * Written as a table because that is what it is. `from` is the rectangle in the legacy sheet and
 * `to` the corner it lands on; every copy is horizontally flipped.
 */
export interface Copy {
  from: readonly [x: number, y: number, width: number, height: number]
  to: readonly [x: number, y: number]
}

export const LEGACY_COPIES: readonly Copy[] = [
  // The right leg at (0,16) becomes the left leg at (16,48).
  { from: [4, 16, 4, 4], to: [20, 48] }, // top
  { from: [8, 16, 4, 4], to: [24, 48] }, // bottom
  { from: [8, 20, 4, 12], to: [16, 52] }, // outer becomes inner
  { from: [4, 20, 4, 12], to: [20, 52] }, // front
  { from: [0, 20, 4, 12], to: [24, 52] }, // inner becomes outer
  { from: [12, 20, 4, 12], to: [28, 52] }, // back

  // The right arm at (40,16) becomes the left arm at (32,48).
  { from: [44, 16, 4, 4], to: [36, 48] }, // top
  { from: [48, 16, 4, 4], to: [40, 48] }, // bottom
  { from: [48, 20, 4, 12], to: [32, 52] }, // outer becomes inner
  { from: [44, 20, 4, 12], to: [36, 52] }, // front
  { from: [40, 20, 4, 12], to: [40, 52] }, // inner becomes outer
  { from: [52, 20, 4, 12], to: [44, 52] }, // back
]

/**
 * The rectangles a **slim** skin leaves empty, and a classic one fills.
 *
 * An arm is four pixels wide on the classic model and three on the slim one, and the box unwrap is
 * derived from that width — so the slim layout simply stops a column short on the four faces that
 * run across the arm. Those leftover columns are what tells the two apart, and they are the only
 * thing that does: the sheet is the same size either way, and nothing in it says which model it is
 * for.
 *
 * Both arms, and both have to be empty. One arm alone would call a classic skin slim whenever an
 * artist happened to leave that column transparent — a sleeve with a notch cut out of it does
 * exactly that.
 */
const SLIM_GAPS: ReadonlyArray<readonly [x: number, y: number, width: number, height: number]> = [
  // Right arm at (40,16): the fourth column of its top and bottom, then of its front and back.
  [50, 16, 2, 4],
  [54, 20, 2, 12],
  // Left arm at (32,48), which only a 64x64 sheet has at all.
  [42, 48, 2, 4],
  [46, 52, 2, 12],
]

/** A skin, and which of the two player models it was drawn for. */
export interface Skin {
  image: HTMLCanvasElement
  /** Three-pixel arms. Alex rather than Steve. */
  slim: boolean
}

/** Bounded LRU of identifier → the in-flight or settled skin. Null means there is none. */
const skins = new Map<string, Promise<Skin | null>>()

const MAX_SKINS = 100

/**
 * The skin for one player, as a canvas ready to be a texture.
 *
 * Memoised on the promise rather than the result, so several entities of the same player — a
 * fleet standing together — share one request. A canvas is a few kilobytes of pixels and is not an
 * object URL, so nothing here has to be revoked; eviction is enough.
 */
export function skinFor(identifier: string): Promise<Skin | null> {
  const key = identifier.toLowerCase()

  const existing = skins.get(key)
  if (existing) {
    // Re-inserted to move it to the end: Map iterates in insertion order, which is what makes the
    // first key the least recently used one.
    skins.delete(key)
    skins.set(key, existing)
    return existing
  }

  const request = fetchSkin(identifier)
  skins.set(key, request)
  evict()
  return request
}

async function fetchSkin(identifier: string): Promise<Skin | null> {
  const bearer = token.value
  if (!bearer) return null

  try {
    const response = await fetch(`${apiBaseUrl}/api/avatars/${encodeURIComponent(identifier)}/skin`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    // Deliberately not routed through the API client: its middleware logs the session out on a 401,
    // and a decorative texture is the last thing that should be able to do that. Every failure here
    // is a player wearing the default skin and nothing more.
    if (!response.ok) return null

    return normalise(await decode(await response.blob()))
  } catch {
    return null
  }
}

/** The blob as an image, or null for anything that will not decode. */
async function decode(blob: Blob): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise<HTMLImageElement | null>((settle) => {
      const image = new Image()
      image.onload = () => settle(image)
      image.onerror = () => settle(null)
      image.src = url
    })
  } finally {
    // Released as soon as the pixels are decoded: what is kept is the canvas, not the blob.
    URL.revokeObjectURL(url)
  }
}

/**
 * A skin on the modern 64x64 layout, whatever it arrived as.
 *
 * A modern sheet is copied straight over — a taller one, from a skin pack that pads the sheet, is
 * cropped to the part the model actually samples rather than refused.
 */
function normalise(image: HTMLImageElement | null): Skin | null {
  if (!image || image.width !== WIDTH) return null

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT

  const paint = canvas.getContext('2d')
  if (!paint) return null

  // Nearest neighbour throughout. Nothing here is scaled, but a smoothed copy of a 4-pixel face
  // would bleed the pixel beside it across the seam.
  paint.imageSmoothingEnabled = false
  paint.drawImage(image, 0, 0, WIDTH, Math.min(image.height, HEIGHT), 0, 0, WIDTH, Math.min(image.height, HEIGHT))

  // A legacy sheet is always classic: slim arms did not exist before the layout that has room for
  // them, so the question is only worth asking of a full-height skin.
  if (image.height >= HEIGHT) return { image: canvas, slim: isSlim(paint) }

  for (const { from, to } of LEGACY_COPIES) {
    const [x, y, width, height] = from
    paint.save()
    // Flipped about the destination's own centre line, which is what turns the right limb into the
    // left one rather than into the right one drawn somewhere else.
    paint.translate(to[0] + width, to[1])
    paint.scale(-1, 1)
    paint.drawImage(image, x, y, width, height, 0, 0, width, height)
    paint.restore()
  }

  return { image: canvas, slim: false }
}

/**
 * Whether every column a slim skin leaves empty is in fact empty.
 *
 * Read off the canvas rather than asked of a profile service: the sheet is already here, the answer
 * is in it, and the alternative is a second authenticated round trip per player to learn something
 * the pixels already say.
 *
 * A canvas that will not give up its pixels — which is what a tainted one does — is read as classic.
 * The image came from a blob this page fetched, so it should never be tainted; being wrong about an
 * arm is better than throwing inside a texture load.
 *
 * **Read once, in full.** One `getImageData` per rectangle is four readbacks off the same canvas,
 * which is what makes the browser ask for `willReadFrequently` — and that would be the wrong answer
 * to the question it asks. The flag moves a canvas onto a software backing to make reads cheap, and
 * this canvas is about to be uploaded as a texture, which is the thing a GPU-backed one is fast at.
 * A 64x64 sheet is 16KB; taking all of it once costs less than the four calls it replaces.
 */
function isSlim(paint: CanvasRenderingContext2D): boolean {
  try {
    const sheet = paint.getImageData(0, 0, WIDTH, HEIGHT).data

    return SLIM_GAPS.every(([x, y, width, height]) => {
      for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) {
          // Every fourth byte is alpha. Anything drawn at all makes this a classic sheet.
          if (sheet[(row * WIDTH + column) * 4 + 3] !== 0) return false
        }
      }
      return true
    })
  } catch {
    return false
  }
}

function evict(): void {
  while (skins.size > MAX_SKINS) {
    const oldest = skins.keys().next()
    if (oldest.done) return
    skins.delete(oldest.value)
  }
}

/**
 * Dropped when the token changes, exactly as the heads are.
 *
 * A skin that could not be fetched while logged out must not stay cached as "this player has none"
 * for the session that follows. Nothing to revoke here: what is held is a canvas, not an object URL.
 */
// Synchronous, for the reason `avatars.ts` gives: the next thing after a logout may be a render.
watch(token, () => clearSkins(), { flush: 'sync' })

export function clearSkins(): void {
  skins.clear()
}
