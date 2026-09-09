/**
 * The search, which is ours.
 *
 * **A\* over whatever squares something else says are reachable.** It knows nothing about Minecraft:
 * a caller hands it a start, a way of asking "what can I reach from here", and a goal that can score
 * a square and recognise the end. Walking passes upstream's `Movements`, which is where the hard-won
 * geometry lives and which there is no reason to rewrite. Flying will pass its own, and get this
 * search, its tie-breaking and its budget for free.
 *
 * **Why not upstream's.** Two things about `lib/astar.js` are wrong for this host rather than merely
 * different:
 *
 * - *It zigzags.* Its heuristic is octile distance and its steps cost 1 straight, √2 diagonal - so on
 *   open ground `h` is exactly the true remaining cost, every optimal route scores an identical `f`,
 *   and which of the tied staircases comes out is down to what order a binary heap happened to hold
 *   them in. See {@link TURN}.
 * - *Its unfinished answer is a guess with no warning label.* `partial` reconstructs from the node
 *   with the lowest `h` seen, ranked on the heuristic alone, and hands back a whole route; two
 *   columns being pillared side by side score within a fraction of each other, so the answer flips
 *   between them tick to tick. Here an unfinished search says so - see {@link Outcome} - and it
 *   reports the best route through a square it actually *expanded*, not a frontier node it merely
 *   glanced at.
 */

/**
 * One square, as both this search and upstream's `Move` describe it.
 *
 * Structural on purpose: a real `Move` satisfies it without being imported, so the walking neighbour
 * source can hand its own objects straight through and a test can hand a plain one.
 */
export interface Step {
  readonly x: number
  readonly y: number
  readonly z: number
  /** What makes two squares the same square. Upstream's is `x,y,z`. */
  readonly hash: string
  /** What it costs to arrive here from the square that offered it. */
  readonly cost: number
}

/** Where the search is trying to get to. */
export interface Goal {
  /** Whether this square will do. */
  reached(at: Step): boolean
  /** What it should cost to get from here to the end. Must never overstate, or the answer is wrong. */
  estimate(at: Step): number
}

/** What can be reached from a square, in one step each. */
export type Neighbours = (from: Step) => readonly Step[]

/**
 * How a search ended.
 *
 * `partial` is the one that matters, and the reason this is reported rather than inferred: it means
 * the search ran out of its slice and *has not decided yet*. A caller may walk the route it comes
 * with - a guess about which way to go costs a tick, and the next slice corrects it - but must not
 * spend blocks on one. See `settled.ts`.
 */
export type Outcome = 'found' | 'partial' | 'nowhere' | 'timeout'

export interface Route {
  outcome: Outcome
  /** The squares to pass through, the first being the one after the start. */
  steps: Step[]
  /** What the route costs, by the same arithmetic the neighbour source prices steps in. */
  cost: number
  /** How many squares were expanded to find it, which is the only honest measure of a search. */
  looked: number
}

/**
 * What one change of direction costs.
 *
 * **The whole answer to the zigzag**, and priced rather than post-processed. A tenth of a step is far
 * too small to send a route the long way round, and enough to settle every tie on open ground in
 * favour of carrying straight on - which is what a route with fewer turns is worth in a game where
 * every turn is a sprint that has to be restarted.
 *
 * Charged in `g` rather than smuggled into the heuristic, so what the search returns is still the
 * cheapest route by the rules it was given; the rules simply now say that turning costs something,
 * which is true.
 */
const TURN = 0.1

/** How long one search may run in total before it gives up, in milliseconds. */
const BUDGET = 5_000

/** How long one call to {@link Search.run} may think for, in milliseconds. */
const SLICE = 20

/** One square as the search holds it, with where it came from and what it has cost so far. */
interface Held {
  step: Step
  g: number
  h: number
  f: number
  /** The direction it was entered from, as signs, for pricing a turn. Zero when it did not move. */
  dx: number
  dz: number
  from: Held | undefined
}

export interface Limits {
  /** How long the whole search may run. */
  budget?: number
  /** How long one slice may run. */
  slice?: number
  /**
   * How far past the straight-line estimate a route may cost before it is not worth having.
   *
   * Upstream's `searchRadius`, and the same arithmetic: a bound on `f`, not on distance from the
   * agent. Absent means no bound.
   */
  reach?: number
}

/**
 * One search, run a slice at a time.
 *
 * Held rather than called, because a search that cannot finish inside one tick has to be able to
 * carry on inside the next without starting again - and because the caller needs to be told which
 * of those it is looking at.
 */
export class Search {
  private readonly open = new Heap()
  private readonly seen = new Map<string, Held>()
  private readonly done = new Set<string>()

  private readonly startedAt = Date.now()
  private readonly budget: number
  private readonly slice: number
  private readonly ceiling: number

  /** The expanded square that has come closest, which is what an unfinished search has to offer. */
  private best: Held

  private looked = 0

  constructor(
    start: Step,
    private readonly neighbours: Neighbours,
    private readonly goal: Goal,
    limits: Limits = {},
  ) {
    this.budget = limits.budget ?? BUDGET
    this.slice = limits.slice ?? SLICE

    const h = this.goal.estimate(start)
    const first: Held = { step: start, g: 0, h, f: h, dx: 0, dz: 0, from: undefined }

    this.ceiling = limits.reach === undefined ? Infinity : h + limits.reach
    this.best = first
    this.open.push(first)
    this.seen.set(start.hash, first)
  }

  /**
   * Thinks for one slice.
   *
   * Call again while the outcome is `partial`. Every other outcome is final, and calling again after
   * one answers the same thing without doing any more work.
   */
  run(): Route {
    const until = Date.now() + this.slice

    while (!this.open.empty()) {
      // **The budget first, and it matters which order.** With the slice tested first, a search that
      // fills its slice returns `partial` before the budget is ever looked at - and since the caller
      // answers a partial by running another slice, the budget is unreachable for exactly the
      // searches it exists to stop. What that looks like from outside is an agent that plans, never
      // moves, never fails and never says anything, while a core sits at a hundred percent.
      if (Date.now() - this.startedAt >= this.budget) return this.route('timeout', this.best)
      if (Date.now() >= until) return this.route('partial', this.best)

      const node = this.open.pop()
      if (!node) break

      if (this.goal.reached(node.step)) return this.route('found', node)

      this.seen.delete(node.step.hash)
      this.done.add(node.step.hash)
      this.looked++

      // Closest by the estimate, among squares actually expanded. A frontier square has been
      // scored and nothing more, and a route through one is a route nobody has checked.
      if (node.h < this.best.h) this.best = node

      this.expand(node)
    }

    return this.route('nowhere', this.best)
  }

  private expand(node: Held): void {
    for (const step of this.neighbours(node.step)) {
      if (this.done.has(step.hash)) continue

      // Signs rather than the offset itself: a step of two blocks in one direction is the same
      // direction as a step of one, and only the change of direction is being priced.
      const dx = Math.sign(step.x - node.step.x)
      const dz = Math.sign(step.z - node.step.z)

      // A move straight up or down keeps whatever direction it was already going, so a tower does
      // not read as a turn at each end of itself.
      const turning = (dx !== 0 || dz !== 0) && (node.dx !== 0 || node.dz !== 0) && (dx !== node.dx || dz !== node.dz)

      const g = node.g + step.cost + (turning ? TURN : 0)
      const h = this.goal.estimate(step)
      if (g + h > this.ceiling) continue

      const held = this.seen.get(step.hash)

      if (!held) {
        const fresh: Held = { step, g, h, f: g + h, dx: dx || node.dx, dz: dz || node.dz, from: node }
        this.seen.set(step.hash, fresh)
        this.open.push(fresh)
        continue
      }

      if (held.g <= g) continue

      held.step = step
      held.g = g
      held.h = h
      held.f = g + h
      held.dx = dx || node.dx
      held.dz = dz || node.dz
      held.from = node
      this.open.rescore(held)
    }
  }

  private route(outcome: Outcome, at: Held): Route {
    const steps: Step[] = []
    for (let node: Held | undefined = at; node?.from; node = node.from) steps.push(node.step)
    steps.reverse()

    return { outcome, steps, cost: at.g, looked: this.looked }
  }
}

/**
 * A binary heap ordered by `f`, and by `h` where `f` ties.
 *
 * **The tie-break is the point.** With an exactly tight heuristic every optimal route scores the
 * same `f`, so without a second key the order is whatever the heap's internals happened to produce -
 * which is the zigzag, and also a great deal of wasted expansion, because the search spreads sideways
 * across a plateau of equal-scoring squares instead of driving at the goal. Preferring the smaller
 * `h` walks the plateau end-first.
 */
class Heap {
  private readonly items: Held[] = []
  private readonly at = new Map<Held, number>()

  empty(): boolean {
    return this.items.length === 0
  }

  push(item: Held): void {
    this.items.push(item)
    this.at.set(item, this.items.length - 1)
    this.up(this.items.length - 1)
  }

  pop(): Held | undefined {
    const top = this.items[0]
    if (!top) return undefined

    const last = this.items.pop()
    this.at.delete(top)

    if (last && last !== top) {
      this.items[0] = last
      this.at.set(last, 0)
      this.down(0)
    }

    return top
  }

  /** Something already in the heap got cheaper, so it has to move up. */
  rescore(item: Held): void {
    const index = this.at.get(item)
    if (index === undefined) {
      this.push(item)
      return
    }

    this.up(index)
  }

  private before(one: Held, other: Held): boolean {
    if (one.f !== other.f) return one.f < other.f
    return one.h < other.h
  }

  private up(from: number): void {
    let index = from

    while (index > 0) {
      const parent = (index - 1) >> 1
      const here = this.items[index]
      const above = this.items[parent]
      if (!here || !above || !this.before(here, above)) break

      this.swap(index, parent)
      index = parent
    }
  }

  private down(from: number): void {
    let index = from

    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let best = index

      const here = this.items[best]
      const one = this.items[left]
      const other = this.items[right]
      if (!here) break

      if (one && this.before(one, here)) best = left

      const winner = this.items[best]
      if (other && winner && this.before(other, winner)) best = right

      if (best === index) break

      this.swap(index, best)
      index = best
    }
  }

  private swap(one: number, other: number): void {
    const first = this.items[one]
    const second = this.items[other]
    if (!first || !second) return

    this.items[one] = second
    this.items[other] = first
    this.at.set(second, one)
    this.at.set(first, other)
  }
}
