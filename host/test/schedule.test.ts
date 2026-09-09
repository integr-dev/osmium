import { describe, expect, it } from 'vitest'

import { type Job, RANK, Schedule } from '../src/agent/schedule.ts'

/** A promise somebody else decides the fate of. */
function held() {
  let settle: () => void = () => {}
  let fail: (why: Error) => void = () => {}

  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  return { promise, settle, fail }
}

/**
 * A job that holds the hands until a test lets go, and writes down what happened to it.
 *
 * `ran` counts attempts rather than completions, which is the whole difference this file is about:
 * a job that was cut in on has run twice and finished once.
 */
function work(name: string, rank: number, done: ReturnType<typeof held>, extra: Partial<Job> = {}) {
  const log: string[] = []
  let ran = 0

  const job: Job = {
    name,
    rank,
    ...extra,
    run: async (signal) => {
      ran++
      log.push(`${name} started`)

      await Promise.race([
        done.promise,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('put down')), { once: true })
        }),
      ])

      log.push(`${name} finished`)
    },
  }

  return { job, log, attempts: () => ran }
}

/** Lets every already-settled promise actually run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Schedule', () => {
  it('runs one job at a time', async () => {
    const queue = new Schedule(1)
    const first = held()
    const second = held()

    const eating = work('eating', RANK.HEAL, first)
    const tidying = work('tidying', RANK.TIDY, second)

    void queue.add(eating.job)
    void queue.add(tidying.job)
    await flush()

    expect(tidying.attempts()).toBe(0)
    expect(queue.busy()).toBe(true)

    first.settle()
    await flush()

    expect(tidying.attempts()).toBe(1)
  })

  it('takes the more important job first when both are waiting', async () => {
    const queue = new Schedule(1)
    const blocking = held()
    const holder = work('building', RANK.BUILD, blocking)

    void queue.add(holder.job)
    await flush()

    const later = held()
    const sooner = held()
    const tidying = work('tidying', RANK.TIDY, later)
    const totem = work('totem', RANK.TOTEM, sooner)

    void queue.add(tidying.job)
    void queue.add(totem.job)

    // The totem outranks the job holding the hands, so it does not wait for either.
    await flush()
    expect(totem.attempts()).toBe(1)
    expect(tidying.attempts()).toBe(0)
  })

  it('interrupts a job that matters less, and runs it again afterwards', async () => {
    const queue = new Schedule(1)
    const eating = held()
    const totem = held()

    const gapple = work('eating', RANK.HEAL, eating)
    const refill = work('totem', RANK.TOTEM, totem)

    const finished = queue.add(gapple.job)
    await flush()
    expect(gapple.attempts()).toBe(1)

    // Erik's case: the totem cuts in on the apple.
    void queue.add(refill.job)
    await flush()

    expect(refill.attempts()).toBe(1)
    expect(gapple.log).toEqual(['eating started'])

    totem.settle()
    await flush()

    // Put back rather than dropped: the apple is being eaten again, from the top.
    expect(gapple.attempts()).toBe(2)

    eating.settle()
    await flush()

    await expect(finished).resolves.toBeUndefined()
    expect(gapple.log).toEqual(['eating started', 'eating started', 'eating finished'])
  })

  it('settles the caller once, however many times the job was put down', async () => {
    const queue = new Schedule(1)
    const eating = held()
    const gapple = work('eating', RANK.HEAL, eating)

    const finished = queue.add(gapple.job)
    let settled = 0
    void finished.then(() => settled++)

    await flush()

    for (const _ of [1, 2, 3]) {
      const cut = held()
      void queue.add(work('totem', RANK.TOTEM, cut).job)
      await flush()
      cut.settle()
      await flush()
    }

    eating.settle()
    await flush()

    expect(gapple.attempts()).toBe(4)
    expect(settled).toBe(1)
  })

  it('waits for a job that must not be cut in on', async () => {
    const queue = new Schedule(1)
    const moving = held()
    const shuffle = work('moving a stack', RANK.TIDY, moving, { yields: false })
    const totem = held()
    const refill = work('totem', RANK.TOTEM, totem)

    void queue.add(shuffle.job)
    await flush()

    void queue.add(refill.job)
    await flush()

    // Abandoning a click sequence partway would leave an item in a slot nobody owns.
    expect(refill.attempts()).toBe(0)
    expect(shuffle.attempts()).toBe(1)

    moving.settle()
    await flush()

    expect(refill.attempts()).toBe(1)
  })

  it('does not queue the same thing twice', async () => {
    const queue = new Schedule(1)
    const blocking = held()
    void queue.add(work('building', RANK.BUILD, blocking).job)
    await flush()

    const once = held()
    const first = work('totem', RANK.TOTEM, once, { key: 'totem' })
    const again = work('totem', RANK.TOTEM, once, { key: 'totem' })

    // Both callers are told when the one refill is done.
    const a = queue.add(first.job)
    const b = queue.add(again.job)

    expect(a).toBe(b)
    expect(queue.depth()).toBe(1)
  })

  it('tells the caller when a job actually fails', async () => {
    const queue = new Schedule(1)
    const broken = held()
    const doomed = work('eating', RANK.HEAL, broken)

    const finished = queue.add(doomed.job)
    await flush()

    broken.fail(new Error('the window closed'))

    await expect(finished).rejects.toThrow('the window closed')
  })

  it('lets go of everything when the session ends', async () => {
    const queue = new Schedule(1)
    const blocking = held()
    void queue.add(work('building', RANK.BUILD, blocking).job)
    await flush()

    const waiting = queue.add(work('tidying', RANK.TIDY, held()).job)
    queue.stop()

    await expect(waiting).rejects.toThrow('the agent stopped')
  })
})
