/**
 * What an agent is working on, and how fast, so it can say so when asked.
 *
 * **A piece, not a job.** An agent holds one segment of one job and knows nothing about the others:
 * how many pieces there are, who has them, or how far along they are. So everything here is about
 * the box this agent was handed, and the wording of the answers says so — a bot reporting "4,096
 * blocks left" for a job of forty pieces would be wrong by a factor of forty, and wrong in the
 * confident direction.
 *
 * The rate is measured rather than assumed. A build slows down when the agent has to go for
 * materials and a survey slows down over a server that is chunk-starved, so anything worked out
 * from a nominal blocks-per-second would be a number that is only right on an empty flat world.
 */

/** What kind of work it is, which is the same distinction the job types make. */
export type WorkKind = 'build' | 'survey'

/**
 * How long a sample is worth using, in milliseconds.
 *
 * **The recent rate, not the average since it started.** An agent that spent ten minutes stuck on
 * scaffolding and is now placing steadily has an average that describes neither, and the useful
 * answer to "how long" is about what it is doing now. Old samples are dropped rather than weighted:
 * a window is one number to explain and a decay is two.
 */
const WINDOW_MS = 120_000

/** Below this the rate is noise, and an estimate from it is a number with hours of error in it. */
const ENOUGH = 4

interface Sample {
  at: number
  done: number
}

export class Work {
  private readonly samples: Sample[] = []

  constructor(
    readonly kind: WorkKind,
    /** What the job is called, as the operator named it. Pinned when the piece was handed out. */
    readonly name: string,
    readonly segmentId: number,
    /** Blocks to place, or columns of ground to chart. */
    readonly total: number,
    readonly startedAt: number = Date.now(),
  ) {}

  /** How much of the piece is finished, as last reported to the backend. */
  get done(): number {
    return this.samples.at(-1)?.done ?? 0
  }

  get left(): number {
    return Math.max(0, this.total - this.done)
  }

  /** Rounded down: 99% is the honest reading for a piece with one block left in it. */
  get percent(): number {
    if (this.total <= 0) return 100
    return Math.min(100, Math.floor((this.done / this.total) * 100))
  }

  /**
   * A reading, at the moment it was reported.
   *
   * Taken from the same count that goes to the backend rather than from a counter of its own, so
   * what an agent says in chat and what the job card shows cannot come apart.
   */
  note(done: number, at: number = Date.now()): void {
    this.samples.push({ at, done })
    while (this.samples.length > 1 && at - this.samples[0]!.at > WINDOW_MS) this.samples.shift()
  }

  /** Blocks or columns a second over the window, or null while there is too little to say. */
  get rate(): number | null {
    const first = this.samples[0]
    const last = this.samples.at(-1)
    if (!first || !last || last === first) return null

    const seconds = (last.at - first.at) / 1000
    const moved = last.done - first.done
    if (seconds <= 0 || moved < ENOUGH) return null

    return moved / seconds
  }

  /**
   * How much longer this piece will take, in milliseconds, or null when nothing can be said.
   *
   * Null rather than a guess in the two cases that matter: a piece that has not moved far enough to
   * have a rate, and one that has stopped moving altogether. A stalled agent reporting "3 minutes"
   * for the rest of the afternoon is worse than one that admits it does not know — the operator
   * acts on the first and investigates the second.
   */
  get etaMs(): number | null {
    const rate = this.rate
    if (rate === null || rate <= 0) return null
    if (this.left === 0) return 0
    return (this.left / rate) * 1000
  }
}

/** The unit a count is in, which is what makes the number mean anything. */
export function unitOf(kind: WorkKind, count: number): string {
  const one = kind === 'build' ? 'block' : 'column'
  return `${count.toLocaleString('en-GB')} ${one}${count === 1 ? '' : 's'}`
}

/**
 * A length of time somebody in a chat window can read: `40s`, `12m`, `1h 20m`.
 *
 * Shorter than the words `lasted` uses, because this one is read in a line that already carries a
 * name, a count and a percentage, and because an estimate rounded to the hour should not be dressed
 * up as more precise than it is.
 */
export function shortly(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`

  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}
