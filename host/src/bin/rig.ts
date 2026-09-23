import { mkdirSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

import { log, reason } from '../log.ts'
import { formatOrder } from '../agent/order.ts'
import { layout, pack } from '../rig/layout.ts'
import { schematic } from '../rig/schem.ts'
import { orderArgument, runRig, verifyBuild, type Report } from '../rig/harness.ts'
import { probe, type Support } from '../rig/probe.ts'
import { formatSpec, planFor } from '../agent/build/plan.ts'
import { itemFor } from '../agent/build/materials.ts'
import type { BlockPos } from '../protocol/wire.ts'

/**
 * The build rig.
 *
 * ```
 *   npm run rig -- generate                 write the torture schematic to ./rig
 *   npm run rig -- run                      build it on localhost and report
 *   npm run rig -- run --order y+x+z+s      the same, in a different order
 *   npm run rig -- plan oak_stairs[...]     what this host would do to place that state
 *   npm run rig -- probe observer barrel    what the server makes of one, from every look
 *   npm run rig -- verify --anchor 900,-59,900
 *                                           read a build back without building it
 * ```
 *
 * `run` expects the server `testserver/setup.sh` puts up: offline, creative, flat, with the name it
 * connects as in `ops.json` — it clears the box with `/fill` before every run, so a report is about
 * this run rather than about everything that has ever been built there.
 */

const USAGE = `osmium build rig

  rig generate [--out <dir>] [--anchor x,y,z]
  rig run [--host <h>] [--port <n>] [--name <n>] [--version <v>]
          [--anchor x,y,z] [--order <token>]
          [--reach <n>] [--rate <n>] [--window <n>] [--no-tune]
  rig verify [--anchor x,y,z] [--host <h>] [--port <n>] [--name <n>] [--version <v>]
  rig plan <state> [<state>...]
  rig probe <item> [<item>...] [--from floor|wall|ceiling] [--at x,y,z] [--air]
                   [--host <h>] [--port <n>] [--name <n>] [--version <v>]
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'generate') return generate(args)
  if (command === 'run') return run(args)
  if (command === 'verify') return check(args)
  if (command === 'plan') return explain(args.slice(1))
  if (command === 'probe') return measure(args)

  process.stdout.write(USAGE)
  process.exit(command === undefined || command === '--help' ? 0 : 1)
}

function generate(args: string[]): void {
  const out = flag(args, '--out') ?? 'rig'
  const anchor = anchorOf(flag(args, '--anchor'))
  const view = layout(anchor)

  mkdirSync(out, { recursive: true })
  writeFileSync(joinPath(out, 'torture.schem'), schematic(view))
  writeFileSync(joinPath(out, 'torture.osm1'), pack(view))
  writeFileSync(
    joinPath(out, 'plots.json'),
    `${JSON.stringify({ min: view.min, size: view.size, plots: view.plots }, null, 2)}\n`,
  )

  log.info(
    `${view.plots.length} specimens, ${view.blocks.length} blocks, ` +
      `${view.size.x}x${view.size.y}x${view.size.z} at ${anchor.x} ${anchor.y} ${anchor.z} -> ${out}/`,
  )
}

async function run(args: string[]): Promise<void> {
  const order = orderArgument(flag(args, '--order'))

  const settings: Record<string, string> = {}
  const reach = flag(args, '--reach')
  const rate = flag(args, '--rate')
  const window = flag(args, '--window')
  if (reach) settings['build.reach'] = reach
  if (rate) settings['build.rate'] = rate
  if (window) settings['build.window'] = window
  if (args.includes('--no-tune')) settings['build.tune'] = 'false'

  const report = await runRig({
    host: flag(args, '--host') ?? '127.0.0.1',
    port: Number(flag(args, '--port') ?? 25565),
    username: flag(args, '--name') ?? 'probe',
    version: flag(args, '--version') ?? '1.21.4',
    anchor: anchorOf(flag(args, '--anchor')),
    order,
    settings,
  })

  print(report, formatOrder(order))
  process.exit(report.wrong.length === 0 ? 0 : 1)
}

/**
 * The report.
 *
 * Grouped by specimen and then by what was wrong with it, because a printer with one bad rule has
 * it wrong on every block of that family — and a hundred identical lines say less than one line
 * with a count beside it.
 */
function print(report: Report, order: string): void {
  const out = process.stdout

  out.write(`\nbuilt in ${order}: ${report.outcome}, ${report.placed} placed, ${report.seconds}s\n`)
  out.write(`specimens: ${report.right} of ${report.plots} exactly right\n\n`)

  if (report.wrong.length === 0) {
    out.write('nothing came out wrong\n')
    return
  }

  const byFamily = new Map<string, { plots: Set<string>; misses: Map<string, number>; sample: string }>()
  for (const entry of report.wrong) {
    const family = entry.plot.split('/')[0] ?? entry.plot
    const held = byFamily.get(family) ?? { plots: new Set<string>(), misses: new Map(), sample: '' }

    held.plots.add(entry.plot)
    for (const miss of entry.misses) {
      const label = `${miss.property}: wanted ${miss.want}, got ${miss.have}`
      held.misses.set(label, (held.misses.get(label) ?? 0) + 1)
      if (!held.sample) held.sample = `${entry.plot} at ${entry.at.x} ${entry.at.y} ${entry.at.z}`
    }

    byFamily.set(family, held)
  }

  const families = [...byFamily.entries()].sort((a, b) => b[1].plots.size - a[1].plots.size)
  for (const [family, held] of families) {
    out.write(`${family}  (${held.plots.size} specimens)\n`)
    out.write(`  first: ${held.sample}\n`)
    for (const [label, count] of [...held.misses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      out.write(`  ${String(count).padStart(4)}  ${label}\n`)
    }
    for (const entry of report.wrong.filter((miss) => miss.plot.split('/')[0] === family).slice(0, 3)) {
      const what = entry.misses.map((miss) => `${miss.property} ${miss.want}/${miss.have}`).join(', ')
      out.write(`      ${entry.at.x} ${entry.at.y} ${entry.at.z}  ${entry.plot}  ${what}\n`)
    }
    out.write('\n')
  }

  if (report.drift.length > 0) {
    out.write('what the printer noticed while building:\n')
    for (const [what, count] of report.drift.slice(0, 20)) {
      out.write(`  ${String(count).padStart(4)}  ${what}\n`)
    }
    out.write('\n')
  }
}

/**
 * Reads back a build somebody else placed — an agent, through the real pipeline, hours ago.
 *
 * The same check `run` finishes with, pointed at a box rather than at a run. What it needs is
 * the corner the build was placed at, which is the placement on the build in Osmium.
 */
async function check(args: string[]): Promise<void> {
  const report = await verifyBuild({
    host: flag(args, '--host') ?? '127.0.0.1',
    port: Number(flag(args, '--port') ?? 25565),
    username: flag(args, '--name') ?? 'probe',
    version: flag(args, '--version') ?? '1.21.4',
    anchor: anchorOf(flag(args, '--anchor')),
    order: orderArgument(undefined),
    settings: {},
  })

  print(report, 'whatever built it')
  process.exit(report.wrong.length === 0 ? 0 : 1)
}

/**
 * What this host would do to place a state, without a server in the room.
 *
 * The other half of `probe`: this says what the plan intends and that says what the game
 * actually does, and a family that fails in the rig is one of the two being wrong.
 */
function explain(states: readonly string[]): void {
  const out = process.stdout

  for (const state of states) {
    const plan = planFor(state)
    out.write(`\n${formatSpec({ name: state, properties: {} })}\n`)
    out.write(`  item:  ${itemFor(state) ?? "(none — cannot be placed)"}\n`)

    if (plan.free) {
      out.write("  free:  placed by its other half\n")
      continue
    }

    if (plan.copies > 1) out.write(`  place: ${plan.copies} times into the same square\n`)

    for (const option of plan.options) {
      const parts = [`click the block ${option.against} of it`]
      if (option.yaw) parts.push(`facing ${option.yaw}`)
      if (option.nearest) parts.push(`looking ${option.nearest}`)
      if (option.rotation !== undefined) parts.push(`turned to ${option.rotation}/16`)
      if (option.cursor) parts.push(`at ${JSON.stringify(option.cursor)}`)
      out.write(`  way:   ${parts.join(", ")}\n`)
    }

    if (plan.options.length === 0) out.write("  way:   nothing here knows how\n")
    for (const knob of plan.tune) out.write(`  click: ${knob.property}\n`)
    if (plan.drift.length > 0) out.write(`  drift: ${plan.drift.join(", ")}\n`)
  }

  out.write("\n")
}

/** What the server makes of one placement, from every direction the agent can look. */
async function measure(args: string[]): Promise<void> {
  const items = args.slice(1).filter((arg) => !arg.startsWith("--"))
  const skip = new Set<string>()
  for (const name of ["--from", "--at", "--host", "--port", "--name", "--version"]) {
    const value = flag(args, name)
    if (value) skip.add(value)
  }

  const wanted = items.filter((item) => !skip.has(item))
  if (wanted.length === 0) throw new Error("name at least one item to probe")

  const results = await probe({
    host: flag(args, "--host") ?? "127.0.0.1",
    port: Number(flag(args, "--port") ?? 25565),
    username: flag(args, "--name") ?? "probe",
    version: flag(args, "--version") ?? "1.21.4",
    at: anchorOf(flag(args, "--at") ?? "200,-59,200"),
    items: wanted,
    from: (flag(args, "--from") as Support | undefined) ?? "floor",
    air: args.includes("--air"),
  })

  const out = process.stdout
  for (const result of results) {
    out.write(`\n${result.item}, clicked from the ${result.from}${args.includes("--air") ? ", in air" : ""}\n`)
    for (const found of result.trials) {
      out.write(`  looking ${found.look.padEnd(6)} -> ${found.state}\n`)
    }
  }
  out.write("\n")
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at < 0 || at + 1 >= args.length) return undefined
  return args[at + 1]
}

/** `x,y,z`, or somewhere clear of the flat world's floor when nobody said. */
function anchorOf(value: string | undefined): BlockPos {
  if (!value) return { x: 0, y: -59, z: 0 }

  const parts = value.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`'${value}' is not an x,y,z`)
  }

  return { x: parts[0]!, y: parts[1]!, z: parts[2]! }
}

main().catch((err) => {
  log.error(`rig: ${reason(err)}`)
  process.exit(1)
})
