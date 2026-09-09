import { log } from '../log.ts'

/**
 * One agent, one pair of hands, and an order of importance.
 *
 * **Everything an agent does to its own inventory goes through the same eye of a needle**, and until
 * now the rule at that needle was "whoever asked first". A boolean was set while a click sequence
 * ran and every other module that wanted the hands in that moment was simply turned away - which
 * reads in the log as `could not restock: the window was busy`, over and over, and reads in the
 * world as an agent that will not swap to a pickaxe because it happened to be eating.
 *
 * First-come is the wrong rule, because these jobs are not equally important. Putting a totem back
 * in the off hand is the difference between a session and a corpse; finishing a golden apple is not.
 * So the needle is a queue ordered by how much each job matters, and a job that matters more does
 * not wait for one that matters less - it interrupts it.
 *
 * **Interrupting means starting again, not carrying on.** There is no way to suspend a half-finished
 * `await` in the middle of a click sequence, and there is no such thing as half-eating an apple: the
 * server either consumed it or it did not. So a job that is cut in on is *abandoned* and *put back*,
 * and it runs again from the top once the more important one is done. For every job here that is the
 * honest meaning of "resume", and it is why {@link Job.run} is handed a signal rather than being
 * expected to unwind cleanly on its own.
 *
 * A job that must not be cut in on says so - see {@link Job.yields} - and the queue waits for it.
 */

/** How much a job matters, highest first. One table so the order is arguable in one place. */
export const RANK = {
  /**
   * Getting a totem back into the off hand.
   *
   * Above everything, including healing: an agent with no totem is one hit from the end of its
   * session, and every other job here still exists afterwards.
   */
  TOTEM: 100,
  /** Eating because health is low. The agent is already losing a fight it can still win. */
  HEAL: 80,
  /** Eating because hunger is low. Nothing is going wrong yet, and something is about to. */
  HUNGER: 60,
  /** Laying or breaking a block for a route. Ordinary work, and the first thing worth interrupting. */
  BUILD: 40,
  /** Housekeeping: restocking a hotbar, tidying a stack. Whenever nothing else wants the hands. */
  TIDY: 20,
} as const

/** A piece of work that needs the agent's hands to itself. */
export interface Job {
  /** What it is, for the log. */
  name: string
  /** How much it matters. See {@link RANK}. */
  rank: number
  /**
   * Whether a more important job may cut in while this one runs.
   *
   * **Default is yes**, because most of these are a swap and an action that can simply be done again.
   * A job says no when being abandoned partway would leave the agent worse off than not having
   * started - a sequence of window clicks that moves an item through a slot it must not be left in.
   */
  yields?: boolean
  /**
   * A name for "this same job", so asking twice does not do it twice.
   *
   * Two totem refills queued a millisecond apart are one refill. When given, a job queued while
   * another with the same key is waiting joins that one rather than adding to the queue.
   */
  key?: string
  /**
   * Does the work. Abandoned when the signal aborts.
   *
   * The signal is not a courtesy: a job that ignores it holds the hands until it finishes, and the
   * more important job that asked for them waits exactly that long. Check it around every `await`
   * that costs real time, and let it throw.
   */
  run(signal: AbortSignal): Promise<void>
}

/** A job waiting its turn, with the promise whoever asked for it is holding. */
interface Waiting {
  job: Job
  /** What the caller is holding. Kept so a second ask for the same {@link Job.key} can join it. */
  promise: Promise<void>
  settle: () => void
  fail: (why: Error) => void
  /** How many times a more important job has cut in front of this one. */
  bumped: number
}

/**
 * How many times one job may be interrupted before that is worth a line in the log.
 *
 * Being cut in on once or twice is the scheduler working. A job on its tenth attempt is a job that
 * is never going to get the hands, and somebody should be able to find out why.
 */
const NAGGING = 10

export class Schedule {
  private readonly waiting: Waiting[] = []

  private running: { held: Waiting; stop: AbortController } | undefined

  /** Set while the queue is being walked, so a job finishing does not start a second walk. */
  private walking = false

  constructor(private readonly id: number) {}

  /** Whether anything holds the hands right now. */
  busy(): boolean {
    return this.running !== undefined
  }

  /** What is waiting, for a diagnostic line. */
  depth(): number {
    return this.waiting.length
  }

  /**
   * Puts a job in the queue and answers when it is finally done.
   *
   * The promise covers every attempt: a job interrupted three times settles once, when it actually
   * finished. A caller cannot tell interruption from slowness, and should not have to.
   */
  add(job: Job): Promise<void> {
    if (job.key !== undefined) {
      const held = this.waiting.find((other) => other.job.key === job.key)
      if (held) return held.promise
    }

    let settle: () => void = () => {}
    let fail: (why: Error) => void = () => {}

    const promise = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })

    const held: Waiting = { job, promise, settle, fail, bumped: 0 }
    this.put(held)

    // A job that matters more than the one holding the hands takes them, rather than waiting.
    this.interruptFor(job)
    void this.walk()

    return promise
  }

  /**
   * Drops everything, running or waiting.
   *
   * For a session ending. Every caller is told, rather than left holding a promise for work that is
   * never going to happen on a bot that no longer exists.
   */
  stop(): void {
    this.running?.stop.abort()

    const dropped = this.waiting.splice(0, this.waiting.length)
    for (const held of dropped) held.fail(new Error('the agent stopped'))
  }

  /** Highest rank first, and among equals whoever asked first. */
  private put(held: Waiting): void {
    const at = this.waiting.findIndex((other) => other.job.rank < held.job.rank)
    if (at < 0) this.waiting.push(held)
    else this.waiting.splice(at, 0, held)
  }

  /**
   * Takes the hands off whatever is using them, when something better has turned up.
   *
   * The interrupted job is not failed and not dropped: it goes back in the queue, where its own rank
   * puts it ahead of everything less important, and it runs again the moment the hands are free.
   */
  private interruptFor(job: Job): void {
    const running = this.running
    if (!running) return

    if (running.held.job.rank >= job.rank) return
    if (running.held.job.yields === false) return

    log.debug(
      `Agent ${this.id} is putting ${running.held.job.name} down for ${job.name}, which matters more`,
    )

    running.stop.abort()
  }

  private async walk(): Promise<void> {
    if (this.walking) return
    this.walking = true

    try {
      while (!this.running && this.waiting.length > 0) {
        const held = this.waiting.shift()
        if (!held) break

        await this.attempt(held)
      }
    } finally {
      this.walking = false
    }
  }

  private async attempt(held: Waiting): Promise<void> {
    const stop = new AbortController()
    this.running = { held, stop }

    try {
      await held.job.run(stop.signal)
      held.settle()
    } catch (err) {
      // Aborted, not failed: the hands were wanted elsewhere, so this goes back in the queue and
      // the caller is told nothing, because from where it stands nothing has happened yet.
      if (stop.signal.aborted) {
        held.bumped++
        if (held.bumped === NAGGING) {
          log.warn(`Agent ${this.id} has put ${held.job.name} down ${NAGGING} times without finishing it`)
        }

        this.put(held)
        return
      }

      held.fail(err as Error)
    } finally {
      this.running = undefined
    }
  }
}
