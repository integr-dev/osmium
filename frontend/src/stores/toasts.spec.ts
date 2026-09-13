import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FADES_MS, RELEASE_MS, useToastStore } from './toasts'

describe('toast store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('keeps a notice until somebody dismisses it', () => {
    vi.useFakeTimers()
    const toasts = useToastStore()

    toasts.notify('success', 'toast.hostRemoved', { params: { name: 'oslo-1' } })
    vi.advanceTimersByTime(600_000)

    expect(toasts.toasts).toHaveLength(1)

    toasts.dismiss(toasts.toasts[0]!.id)
    expect(toasts.toasts).toHaveLength(0)
    vi.useRealTimers()
  })

  it('folds a notice that would render identically into the one already up', () => {
    const toasts = useToastStore()

    toasts.notify('warning', 'toast.segmentFailed', { params: { name: 'Spawn' } })
    toasts.notify('warning', 'toast.segmentFailed', { params: { name: 'Spawn' } })
    toasts.notify('warning', 'toast.segmentFailed', { params: { name: 'Spawn' } })

    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0]!.count).toBe(3)
  })

  it('keeps the same notice about two different subjects apart', () => {
    const toasts = useToastStore()

    toasts.notify('success', 'toast.agentRemoved', { params: { name: 'Mason_01' } })
    toasts.notify('success', 'toast.agentRemoved', { params: { name: 'Mason_04' } })

    expect(toasts.toasts).toHaveLength(2)
    expect(toasts.toasts.map((toast) => toast.count)).toEqual([1, 1])
    expect(toasts.toasts.map((toast) => toast.params.name)).toEqual(['Mason_01', 'Mason_04'])
  })

  it('folds a whole class together when the caller asks for it', () => {
    const toasts = useToastStore()

    toasts.notify('warning', 'toast.hostUnreachable', { params: { name: 'oslo-1' }, group: 'hosts' })
    toasts.notify('warning', 'toast.hostUnreachable', { params: { name: 'oslo-2' }, group: 'hosts' })

    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0]!.count).toBe(2)
    // The card keeps what it was raised with rather than being rewritten by the second event: it
    // now stands for both, and half-updating it would make it a report of neither.
    expect(toasts.toasts[0]!.params.name).toBe('oslo-1')
  })

  it('keeps the page a notice is about, and leaves one about nothing without', () => {
    const toasts = useToastStore()

    toasts.notify('warning', 'toast.hostUnreachable', { params: { name: 'oslo-1' }, to: { name: 'host', params: { id: '1' } } })
    toasts.notify('success', 'toast.agentRemoved', { params: { name: 'Mason_01' } })

    expect(toasts.toasts[0]!.to).toEqual({ name: 'host', params: { id: '1' } })
    expect(toasts.toasts[1]!).not.toHaveProperty('to')
  })

  it('takes the severity of the latest of a run', () => {
    const toasts = useToastStore()

    toasts.notify('warning', 'toast.segmentFailed', { params: { name: 'Spawn' } })
    toasts.notify('error', 'toast.segmentFailed', { params: { name: 'Spawn' } })

    expect(toasts.toasts).toHaveLength(1)
    expect(toasts.toasts[0]!.kind).toBe('error')
  })

  it('drops the oldest rather than remembering without limit', () => {
    const toasts = useToastStore()

    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      toasts.notify('info', 'toast.agentRemoved', { params: { name } })
    }

    expect(toasts.toasts.map((toast) => toast.params.name)).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('holds them oldest first, which is the order the deck is laid out in', () => {
    const toasts = useToastStore()

    toasts.notify('info', 'toast.agentRemoved', { params: { name: 'first' } })
    toasts.notify('info', 'toast.agentRemoved', { params: { name: 'second' } })

    expect(toasts.toasts.map((toast) => toast.params.name)).toEqual(['first', 'second'])
  })

  it('clears the corner in one gesture', () => {
    const toasts = useToastStore()

    toasts.notify('info', 'toast.agentRemoved', { params: { name: 'a' } })
    toasts.notify('info', 'toast.agentRemoved', { params: { name: 'b' } })
    toasts.clear()

    expect(toasts.toasts).toHaveLength(0)
  })

  describe('closing by themselves', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    /** "Arrived" is a receipt nobody comes back to, and a corner full of them hid the ones that mattered. */
    it('closes a notice that only says something went as asked', () => {
      const toasts = useToastStore()

      toasts.notify('success', 'toast.path.arrived', { params: { name: 'Mason_01' }, fade: true })
      toasts.notify('error', 'toast.path.failed', { params: { name: 'Mason_02' } })
      vi.advanceTimersByTime(FADES_MS)

      expect(toasts.toasts.map((toast) => toast.key)).toEqual(['toast.path.failed'])
    })

    it('holds it while the deck is being read, and lets it go a moment after', () => {
      const toasts = useToastStore()

      toasts.notify('success', 'toast.path.arrived', { params: { name: 'Mason_01' }, fade: true })
      toasts.hold(true)
      vi.advanceTimersByTime(FADES_MS * 3)
      expect(toasts.toasts).toHaveLength(1)

      toasts.hold(false)
      vi.advanceTimersByTime(RELEASE_MS - 1)
      expect(toasts.toasts).toHaveLength(1)

      vi.advanceTimersByTime(1)
      expect(toasts.toasts).toHaveLength(0)
    })

    it('starts the clock over when the same thing happens again', () => {
      const toasts = useToastStore()

      toasts.notify('success', 'toast.path.arrived', { params: { name: 'Mason_01' }, fade: true })
      vi.advanceTimersByTime(FADES_MS - 1_000)
      toasts.notify('success', 'toast.path.arrived', { params: { name: 'Mason_01' }, fade: true })
      vi.advanceTimersByTime(FADES_MS - 1_000)

      expect(toasts.toasts).toHaveLength(1)
      expect(toasts.toasts[0]!.count).toBe(2)
    })

    /** An arrival is untrue once the same agent reports a failure, and the other way round. */
    it('replaces an older notice on the same topic with the newer one', () => {
      const toasts = useToastStore()

      toasts.notify('error', 'toast.path.failed', { params: { name: 'Mason_01' }, topic: 'path:1' })
      toasts.notify('error', 'toast.path.failed', { params: { name: 'Mason_02' }, topic: 'path:2' })
      toasts.notify('success', 'toast.path.arrived', { params: { name: 'Mason_01' }, topic: 'path:1', fade: true })

      expect(toasts.toasts.map((toast) => `${toast.key} ${String(toast.params.name)}`)).toEqual([
        'toast.path.failed Mason_02',
        'toast.path.arrived Mason_01',
      ])
    })
  })
})
