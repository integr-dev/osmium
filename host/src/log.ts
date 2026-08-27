/**
 * Levelled logging, to stderr, with no dependency.
 *
 * `OSMIUM_LOG` sets the level (`error`, `warn`, `info`, `debug`), defaulting to `info`. Everything
 * goes to stderr so that anything a command-line tool prints for an operator stays separable from
 * the running commentary.
 */
const LEVELS = ['error', 'warn', 'info', 'debug'] as const

type Level = (typeof LEVELS)[number]

const threshold = LEVELS.indexOf((process.env['OSMIUM_LOG']?.toLowerCase() ?? 'info') as Level)
const enabled = threshold === -1 ? LEVELS.indexOf('info') : threshold

function write(level: Level, message: string): void {
  if (LEVELS.indexOf(level) > enabled) return
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`)
}

export const log = {
  error: (message: string) => write('error', message),
  warn: (message: string) => write('warn', message),
  info: (message: string) => write('info', message),
  debug: (message: string) => write('debug', message),

  /** Whether anybody is reading the noisy level.
   *
   * The protocol library logs its own packet failures rather than raising them, and is normally told
   * to stay quiet because it writes for somebody watching a terminal. That silence hides a real
   * class of fault - a chunk that will not parse leaves an agent standing in an empty world, where
   * physics does not run - so it is lifted exactly when somebody has asked for detail.
   */
  debugging: (): boolean => enabled >= LEVELS.indexOf('debug'),
}

/** What an unknown throw actually said. `catch` gives `unknown`, and `${err}` on a plain object
 * prints `[object Object]` - which is the least useful thing a log line can say. */
export function reason(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}
