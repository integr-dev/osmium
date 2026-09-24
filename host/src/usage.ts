import os from 'node:os'

/**
 * What this host costs the machine it runs on: processor and memory, for the process and for the
 * box around it.
 *
 * **Both, because either alone answers the wrong question.** "Is Osmium heavy?" is about the
 * process; "can this machine take another eight agents?" is about the machine, and a host sharing a
 * box with a database will answer those two very differently. An operator looking at a fleet needs
 * the second and an operator looking at a bug needs the first.
 *
 * Every figure is a rate or a level at the moment it is asked for, never a running total: unlike
 * bytes moved, a missed heartbeat loses nothing worth recovering, and a backend that adds up
 * processor samples would be describing an hour that has gone.
 */
export interface Usage {
  /** This process, as a percentage of one core. Two busy cores is 200. */
  cpu: number
  /** Resident set: what the operating system is actually holding for this process, in bytes. */
  memory: number
  /** The whole machine, as a percentage of all its cores together. 100 is every core saturated. */
  systemCpu: number
  /** Memory in use across the machine, in bytes, and what it has in total. */
  systemMemory: number
  systemMemoryTotal: number
}

/** Busy and total processor time across every core, in milliseconds, as the OS has counted them. */
interface Cores {
  busy: number
  total: number
}

function cores(): Cores {
  let busy = 0
  let total = 0
  for (const core of os.cpus()) {
    const times = core.times
    busy += times.user + times.nice + times.sys + times.irq
    total += times.user + times.nice + times.sys + times.irq + times.idle
  }
  return { busy, total }
}

/**
 * Reads the machine and the process, each time against the last read.
 *
 * **Processor use is only ever a difference.** `os.cpus()` and `process.cpuUsage()` both hand back
 * totals since boot or since start, so a single read is a number about the whole uptime — a host
 * that was hammered for an hour this morning would report itself busy for the rest of the day.
 * Holding the previous read and dividing by the elapsed time is what turns them into "right now",
 * and it is why this is a class rather than a function.
 *
 * The first read after a start therefore has nothing to compare against and reports zero rather
 * than a guess. One heartbeat later it is measuring properly.
 */
export class Profiler {
  private last: Cores = cores()
  private lastProcess: NodeJS.CpuUsage = process.cpuUsage()
  private lastAt: number = Date.now()

  read(): Usage {
    const now = Date.now()
    const machine = cores()
    const spent = process.cpuUsage()

    const elapsed = now - this.lastAt
    const machineTotal = machine.total - this.last.total
    // Microseconds of processor time, against milliseconds of wall clock: /1000 makes them agree.
    const processMs = (spent.user - this.lastProcess.user + (spent.system - this.lastProcess.system)) / 1000

    const usage: Usage = {
      cpu: elapsed > 0 ? percent(processMs / elapsed) : 0,
      memory: process.memoryUsage.rss(),
      systemCpu: machineTotal > 0 ? percent((machine.busy - this.last.busy) / machineTotal) : 0,
      systemMemory: os.totalmem() - os.freemem(),
      systemMemoryTotal: os.totalmem(),
    }

    this.last = machine
    this.lastProcess = spent
    this.lastAt = now
    return usage
  }
}

/**
 * A fraction as a percentage, rounded to a tenth and never negative.
 *
 * The floor is not paranoia: `os.cpus()` counters can go backwards across a suspend or a core
 * being taken offline, and a chart with a line below zero on it is a chart nobody trusts again.
 */
function percent(fraction: number): number {
  return Math.max(0, Math.round(fraction * 1000) / 10)
}
