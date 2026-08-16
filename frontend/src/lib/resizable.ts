import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * A panel the operator can drag wider or narrower, remembered across reloads.
 *
 * Which edge the handle sits on decides what dragging right means: it widens a panel anchored to the
 * left and narrows one anchored to the right. Keeping that in one place is why this exists — the two
 * panels are mirror images, and hand-writing the second sign is exactly the kind of thing that ends
 * up backwards.
 */
export type Edge = 'left' | 'right'

/** Where a drag of [delta] pixels leaves a panel that started at [base]. */
export function nextWidth(
  base: number,
  delta: number,
  edge: Edge,
  min: number,
  max: number,
): number {
  return clampWidth(base + (edge === 'right' ? delta : -delta), min, max)
}

export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)))
}

export interface Resizable {
  width: Ref<number>
  /** Bind to the handle's `pointerdown`. */
  start: (event: PointerEvent) => void
  /** Arrow keys on the focused handle, in pointer terms: negative is leftwards. */
  nudge: (delta: number) => void
}

export function useResizable(options: {
  /** localStorage key. A width is a preference, not state the backend has any business knowing. */
  key: string
  initial: number
  min: number
  max: number
  edge: Edge
}): Resizable {
  const { key, initial, min, max, edge } = options

  const stored = Number(localStorage.getItem(key))
  const width = ref(clampWidth(stored > 0 ? stored : initial, min, max))

  let from = 0
  let base = 0

  function onMove(event: PointerEvent): void {
    width.value = nextWidth(base, event.clientX - from, edge, min, max)
  }

  function onUp(): void {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    document.body.style.userSelect = ''
    localStorage.setItem(key, String(width.value))
  }

  function start(event: PointerEvent): void {
    // Otherwise the drag selects text across the whole page, which looks like a fault and leaves a
    // highlight behind when it ends.
    event.preventDefault()
    from = event.clientX
    base = width.value
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function nudge(delta: number): void {
    width.value = nextWidth(width.value, delta, edge, min, max)
    localStorage.setItem(key, String(width.value))
  }

  // A drag that outlives its handle would keep moving a panel that is no longer there.
  onBeforeUnmount(onUp)

  return { width, start, nudge }
}
