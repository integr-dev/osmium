#!/usr/bin/env node
/**
 * What this host holds, from the command line: the Minecraft accounts it can log in with, and the
 * proxies it can route a session through.
 *
 * **The interface is the normal way to add an account.** Choosing "Sign in with Microsoft" when
 * setting an agent up does the same sign-in and puts the code in that agent's activity feed - no
 * shell, no container access, nothing to run on the machine.
 *
 * This is for what the interface cannot reach: a host not enrolled yet, a backend that is down,
 * loading several accounts before any agent exists to use them, the one credential kind nothing can
 * acquire - a Minecraft session token - and **proxies**, which the interface can list but never
 * create, because the password one needs is the thing Osmium deliberately never learns.
 *
 * **Safe to run while the router is running.** Both stores are locked read-modify-writes against
 * what is on disk rather than a dump of what a process last saw. The router reads the proxy file at
 * startup though, so a proxy added here is advertised at its next restart; every command that
 * changes that file says so.
 *
 * **Two ways in, one set of commands.** Given flags it does the thing and prints what happened.
 * Given nothing, and a terminal, it takes the screen and asks - a menu, and a form for anything
 * that needs more than one answer. Every task below builds its report as lines rather than printing
 * as it goes, because in the wizard those lines are a page to be read and in a script they are
 * output to be piped.
 */
import { dial, kinds, proxiesPath, ProxyStore, unusable, type ProxyEntry, type ProxyKind } from '../agent/proxy.ts'
import { log, reason } from '../log.ts'
import { identify, signIn } from '../token/auth.ts'
import { LoginKind } from '../token/login.ts'
import { accountsPath, cachePath } from '../token/paths.ts'
import { AccountStore } from '../token/store.ts'
import type { Field } from './form.ts'
import { Cancelled, header, Screen } from './screen.ts'
import { accent, added, failed, heading, muted, note, ok, removed, say, table, waiting } from './theme.ts'
import { confirm, form, menu } from './views.ts'

/** What a task did, as lines. Printed by the flag path, paged by the wizard. */
type Report = string[]

/** Where this host keeps things, settled once from the flags. */
interface Paths {
  file: string
  cache: string
  proxies: string
}

const USAGE = `osmium-link - the accounts and proxies this host holds

  osmium-link                     take the screen and ask

  osmium-link microsoft           sign in with Microsoft and keep the account
  osmium-link token               add a Minecraft session token
  osmium-link list                show what this host holds
  osmium-link remove <id>         drop one credential

  osmium-link proxy add           add a proxy agents can be routed through
  osmium-link proxy list          show the proxies this host holds
  osmium-link proxy remove <name> drop one
  osmium-link proxy check <name>  dial through it and say whether it worked

  --file <path>                   the account store, default /agent/accounts.json
  --cache <path>                  the Microsoft token cache, default /agent/msa
  --proxies <path>                the proxy file, default /agent/proxies.json

'proxy add' takes --name --kind --host --port --username. The password is never an
argument: it is typed into the form, or read from OSMIUM_PROXY_PASSWORD. Anything
else left out is asked for, when there is a terminal to ask at.
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const where: Paths = {
    file: take(args, '--file') ?? accountsPath(),
    cache: take(args, '--cache') ?? cachePath(),
    proxies: take(args, '--proxies') ?? proxiesPath(),
  }

  const command = args.shift()

  // Nothing at all, with a terminal to draw on: the wizard. Nothing at all without one is a script
  // that has been run wrong - or a terminal that does not look like one, which is its own problem
  // and worth saying out loud rather than answering with the usage.
  if (command === undefined) {
    if (!Screen.available()) {
      process.stderr.write(noTerminal())
      process.exit(2)
    }
    return wizard(where)
  }

  // One screen for the whole run, opened only if something is actually missing - see `asking`.
  let screen: Screen | undefined
  const ask = (): Screen => (screen ??= Screen.open())

  try {
    const report = await run(command, args, where, Screen.available() ? ask : undefined)

    // Closed before anything is printed: the report belongs in the terminal an operator was already
    // looking at, not on a screen that is about to be handed back.
    screen?.close()
    screen = undefined

    for (const line of report) say(line)
    say()
  } finally {
    screen?.close()
  }
}

/** One command, wherever it came from. */
async function run(
  command: string,
  args: string[],
  where: Paths,
  ask: (() => Screen) | undefined,
): Promise<Report> {
  if (command === 'proxy') return proxy(args, where, ask)

  // Opened before anything is asked of the operator, so a store that cannot be read is discovered
  // now rather than after they have approved something there is nowhere to keep.
  const store = await AccountStore.open(where.file)

  switch (command) {
    case 'microsoft':
      return [...heading('sign in with Microsoft', where.file), ...(await microsoft(store, where.cache, ask))]

    case 'token':
      return [...heading('add a session token', where.file), ...(await token(store, ask))]

    case 'list':
      return [...heading('accounts', where.file), ...list(store, where.file)]

    case 'remove':
      return [...heading('remove an account', where.file), ...(await remove(store, args[0], ask))]

    default:
      process.stderr.write(`Unknown command '${command}'.\n\n`)
      process.stderr.write(USAGE)
      process.exit(2)
  }
}

/** The proxy half, which is its own noun and so has its own little tree of commands. */
async function proxy(args: string[], where: Paths, ask: (() => Screen) | undefined): Promise<Report> {
  const store = await ProxyStore.open(where.proxies)
  const command = args.shift()

  switch (command) {
    // Bare `proxy` is the same as `proxy add`: adding is the only one of these that cannot be done
    // anywhere else, and the others are a keystroke away in the wizard.
    case undefined:
    case 'add':
      return [...heading('add a proxy', where.proxies), ...(await addProxy(store, args, ask))]

    case 'list':
      return [...heading('proxies', where.proxies), ...listProxies(store)]

    case 'remove':
      return [...heading('remove a proxy', where.proxies), ...(await removeProxy(store, args[0], ask))]

    case 'check': {
      const to = take(args, '--to')
      return [...heading('check a proxy', where.proxies), ...(await checkProxy(store, args[0], to, ask))]
    }

    default:
      process.stderr.write(`Unknown proxy command '${command}'.\n\n`)
      process.stderr.write(USAGE)
      process.exit(2)
  }
}

// ---- the wizard ---------------------------------------------------------------------------------

/** What the menu offers, and what each one is called at the top of its own screen. */
const TASKS = [
  { value: 'microsoft', label: 'Sign in with Microsoft', hint: '- adds an account to this host', title: 'sign in with Microsoft' },
  { value: 'token', label: 'Add a Minecraft session token', title: 'add a session token' },
  { value: 'list', label: 'List the accounts', title: 'accounts' },
  { value: 'remove', label: 'Remove an account', title: 'remove an account' },
  { value: 'proxy-add', label: 'Add a proxy', hint: '- somewhere to route agents through', title: 'add a proxy' },
  { value: 'proxy-list', label: 'List the proxies', title: 'proxies' },
  { value: 'proxy-remove', label: 'Remove a proxy', title: 'remove a proxy' },
  { value: 'proxy-check', label: 'Check a proxy', hint: '- dial through it and see', title: 'check a proxy' },
] as const

type Task = (typeof TASKS)[number]['value']

/**
 * What to do, for somebody who did not arrive with a command in mind.
 *
 * One list of everything rather than a tree of menus. There are eight things this tool does, and a
 * chooser that made an operator pick "accounts" before it would show them is a keystroke spent on a
 * distinction they do not have yet.
 *
 * **It comes back here when a task is done, and leaves when told to.** A wizard that exits after
 * one answer is a menu you relaunch to use twice — and when it was started by opening the file
 * rather than from a shell, exiting takes the window and everything in it.
 */
async function wizard(where: Paths): Promise<void> {
  const screen = Screen.open()

  try {
    for (;;) {
      let chosen: Task | 'quit'
      try {
        chosen = await menu<Task | 'quit'>(screen, 'this host', 'What would you like to do?', [
          ...TASKS.map((task) => ({ label: task.label, value: task.value, ...('hint' in task ? { hint: task.hint } : {}) })),
          { label: 'Quit', value: 'quit' as const },
        ])
      } catch (err) {
        // Backing out of the top-level list is how you leave, so esc means the same as picking Quit.
        if (err instanceof Cancelled) return
        throw err
      }

      if (chosen === 'quit') return

      const task = TASKS.find((entry) => entry.value === chosen)!

      try {
        const report = await perform(chosen, where, () => screen)
        await screen.page(task.title, report)
      } catch (err) {
        // Backing out of a question inside a task returns to the menu rather than ending the
        // session: the operator changed their mind about that task, not about being here.
        if (err instanceof Cancelled) continue

        /*
         * **And so does a task that fails.** A session token the profile service will not accept, a
         * proxy name already taken, a sign-in that timed out: every one of those is an ordinary
         * answer to what was asked, and throwing it up to the top tore the screen down and left an
         * error line in a terminal that had just been restored - so the wizard appeared to crash on
         * a typo, and whatever else the operator was there to do was lost with it.
         */
        await screen.page(task.title, [failed(reason(err))])
      }

      // A check that could not connect sets this, and inside a session it is not the session's
      // answer: the operator saw the failure on its own page and carried on.
      process.exitCode = 0
    }
  } finally {
    screen.close()
  }
}

/** One thing off the wizard's list, as its report. */
async function perform(chosen: Task, where: Paths, ask: () => Screen): Promise<Report> {
  if (chosen.startsWith('proxy-')) {
    const store = await ProxyStore.open(where.proxies)

    switch (chosen) {
      case 'proxy-add':
        return addProxy(store, [], ask)
      case 'proxy-list':
        return listProxies(store)
      case 'proxy-remove':
        return removeProxy(store, undefined, ask)
      default:
        return checkProxy(store, undefined, undefined, ask)
    }
  }

  const store = await AccountStore.open(where.file)

  switch (chosen) {
    case 'microsoft':
      return microsoft(store, where.cache, ask)
    case 'token':
      return token(store, ask)
    case 'list':
      return list(store, where.file)
    default:
      return remove(store, undefined, ask)
  }
}

// ---- proxies ------------------------------------------------------------------------------------

/**
 * Adds a proxy, asking for whatever was not given — all of it on one screen.
 *
 * **The password is never an argument.** One on a command line is in the shell history and in `ps`
 * for every other user on the machine for as long as this runs — the same reason a session token is
 * not one either. It is typed into the form, shown as dots, or taken from `OSMIUM_PROXY_PASSWORD`
 * for a script with no terminal to type at.
 *
 * Checked before it is written, against the same rules the router applies when it reads the file: a
 * proxy this host would refuse to dial must not be written down as one it holds.
 */
async function addProxy(store: ProxyStore, args: string[], ask: (() => Screen) | undefined): Promise<Report> {
  const given = {
    name: take(args, '--name'),
    kind: take(args, '--kind'),
    host: take(args, '--host'),
    port: take(args, '--port'),
    username: take(args, '--username'),
  }

  const complete = given.name && given.kind && given.host && given.port
  let values: Record<string, string>

  if (complete) {
    values = {
      name: given.name!,
      kind: given.kind!,
      host: given.host!,
      port: given.port!,
      username: given.username ?? '',
      password: process.env['OSMIUM_PROXY_PASSWORD'] ?? '',
    }
  } else {
    if (!ask) throw new Error(missing(given))

    const fields: Field[] = [
      { key: 'name', label: 'Name', kind: 'text', value: given.name ?? '', placeholder: 'resi-eu-1', hint: "what an agent's Route through setting will hold" },
      { key: 'kind', label: 'Kind', kind: 'choice', options: kinds(), value: given.kind ?? kinds()[0]!, hint: 'left and right to change' },
      { key: 'host', label: 'Host', kind: 'text', value: given.host ?? '', placeholder: '10.0.0.9' },
      { key: 'port', label: 'Port', kind: 'text', value: given.port ?? '1080', hint: 'whatever the provider handed out' },
      { key: 'username', label: 'Username', kind: 'text', value: given.username ?? '', hint: 'leave blank if it needs none' },
      { key: 'password', label: 'Password', kind: 'secret', value: '', hint: 'stays on this machine; Osmium never learns it' },
    ]

    values = await form(ask(), 'add a proxy', fields, (entered) =>
      unusable({ name: entered['name'] ?? '', kind: entered['kind'] ?? '', host: entered['host'] ?? '', port: Number(entered['port']) }),
    )
  }

  const wrong = unusable({
    name: values['name'] ?? '',
    kind: values['kind'] ?? '',
    host: values['host'] ?? '',
    port: Number(values['port']),
  })
  if (wrong) throw new Error(wrong)

  const entry: ProxyEntry = {
    name: values['name']!,
    kind: values['kind'] as ProxyKind,
    host: values['host']!,
    port: Number(values['port']),
  }

  if (values['username']) {
    entry.username = values['username']
    if (values['password']) entry.password = values['password']
  }

  await store.add(entry)

  const report = [
    added(`${accent(entry.name)} - ${entry.kind} ${entry.host}:${entry.port}${entry.username ? ' (authenticated)' : ''}`),
    note(`set an agent's "Route through" to ${entry.name} to use it`),
    note('restart the router: it reads this file at startup and advertises what it read'),
  ]

  if (ask && (await confirm(ask(), 'add a proxy', 'Dial through it now to check it works?'))) {
    return [...report, '', ...(await checkProxy(store, entry.name, undefined, ask))]
  }

  return report
}

/** What this host can route through, and where each one goes. Never what it authenticates with. */
function listProxies(store: ProxyStore): Report {
  const entries = store.list()

  if (entries.length === 0) {
    return [note(`nothing in ${store.path}`), note("add one with 'osmium-link proxy add'")]
  }

  return [
    ...table(
      ['NAME', 'KIND', 'ADDRESS', 'AUTH'],
      entries.map((entry) => [entry.name, entry.kind, `${entry.host}:${entry.port}`, entry.username ? 'yes' : 'no']),
    ),
    '',
    note(`${entries.length} in ${store.path}; passwords are held here and never leave this machine`),
  ]
}

async function removeProxy(
  store: ProxyStore,
  name: string | undefined,
  ask: (() => Screen) | undefined,
): Promise<Report> {
  const wanted = name ?? (await pickProxy(store, 'Which proxy should go?', ask))

  if (!(await store.remove(wanted))) return [note('nothing here under that name')]

  return [
    removed(accent(wanted)),
    // The agents naming it are why this is worth saying: they refuse to connect rather than fall
    // back to a direct one, which is the whole point of having routed them.
    note('an agent still set to route through it will refuse to connect, rather than go direct'),
    note('restart the router for it to stop advertising it'),
  ]
}

/**
 * Dials through a proxy and says whether it worked.
 *
 * The one thing the interface cannot do, and the reason this command earns its place: until now the
 * only way to find out a proxy was wrong was to point an agent at it and read the activity feed.
 *
 * A neutral destination by default. What is being tested is whether this proxy will open a TCP
 * connection to somewhere at all, and defaulting to a Minecraft server would put traffic on
 * somebody else's box every time an operator ran a check.
 */
async function checkProxy(
  store: ProxyStore,
  name: string | undefined,
  to: string | undefined,
  ask: (() => Screen) | undefined,
): Promise<Report> {
  const wanted = name ?? (await pickProxy(store, 'Which proxy should I dial through?', ask))
  const entry = store.list().find((held) => held.name === wanted)
  if (!entry) throw new Error(`no proxy called '${wanted}'`)

  const target = to ?? DEFAULT_TARGET
  const at = target.lastIndexOf(':')
  const host = at === -1 ? target : target.slice(0, at)
  const port = at === -1 ? 443 : Number(target.slice(at + 1))

  const dialling = waiting(`dialling ${host}:${port} through ${accent(entry.name)} (${entry.kind} ${entry.host}:${entry.port})`)

  // Said before it is done rather than after: a dial can take the whole fifteen seconds of its
  // deadline, and a screen that sat blank for that long would read as a hang.
  if (ask) ask().paint([...header('check a proxy'), dialling])
  else say(dialling)

  const started = Date.now()
  try {
    const socket = await dial(entry, host, port)
    socket.destroy()
    return [dialling, ok(`connected in ${Date.now() - started}ms`)]
  } catch (err) {
    // Reported rather than thrown: a failed check is a result, and the reason belongs next to the
    // proxy it is about rather than at the bottom of a stack trace.
    process.exitCode = 1
    return [dialling, failed(`failed after ${Date.now() - started}ms: ${reason(err)}`)]
  }
}

/** Somewhere neutral that answers on a well-known port. Overridden with `--to host:port`. */
const DEFAULT_TARGET = 'example.com:443'

/** One of the proxies this host holds, chosen from a list rather than typed from memory. */
async function pickProxy(store: ProxyStore, question: string, ask: (() => Screen) | undefined): Promise<string> {
  const entries = store.list()
  if (entries.length === 0) throw new Error(`there are no proxies in ${store.path}`)
  if (!ask) throw new Error('name the proxy: there is no terminal to ask at')

  return menu(
    ask(),
    'proxies',
    question,
    entries.map((entry) => ({
      label: entry.name,
      value: entry.name,
      hint: `- ${entry.kind} ${entry.host}:${entry.port}`,
    })),
  )
}

// ---- accounts -----------------------------------------------------------------------------------

/** The device code flow: the operator approves in their own browser, and this never sees a
 * password. */
async function microsoft(store: AccountStore, cache: string, ask: (() => Screen) | undefined): Promise<Report> {
  const acquired = await signIn(cache, (code) => {
    const lines = [
      `  ${muted('open')}  ${accent(code.url)}`,
      `  ${muted('code')}  ${accent(code.code)}`,
      '',
      waiting(`waiting for approval; the code expires in ${Math.round(code.expiresIn / 60)} minutes`),
    ]

    // Painted rather than printed while the screen is up: this is the one task that waits on
    // somebody outside the terminal, and what it is waiting for has to stay on screen.
    if (ask) ask().paint([...header('sign in with Microsoft'), ...lines])
    else for (const line of lines) say(line)
  })

  // Unbound: this loads an account into the pool, and which agent ends up playing it is decided
  // later by whoever sets one up.
  await store.adopt({
    kind: LoginKind.RefreshToken,
    cache: acquired.cache,
    username: acquired.username,
    uuid: acquired.uuid,
  })

  // The account, never the credential. Nothing here prints a token: it is live, and a terminal is
  // scrollback, screen shares and shell history.
  return [
    added(`${accent(acquired.username)} (${acquired.uuid})`),
    note("set an agent up with 'Stored Microsoft account' to use it"),
  ]
}

/**
 * A Minecraft session token, which nothing in Osmium can obtain - so this is the only way one gets
 * onto a host.
 *
 * **Never an argument.** A token on a command line is in the shell history and in `ps` for every
 * other user on the machine for as long as this runs. Typed into a field that shows dots, and read
 * from stdin when there is no terminal - which is what a script piping one in has always done.
 */
async function token(store: AccountStore, ask: (() => Screen) | undefined): Promise<Report> {
  const raw = ask
    ? (
        await form(ask(), 'add a session token', [
          {
            key: 'token',
            label: 'Session token',
            kind: 'secret',
            value: '',
            hint: 'cannot be renewed; expect it to stop working in about a day',
          },
        ])
      )['token']
    : await piped()

  if (!raw) throw new Error('no token given')

  // Checked before it is written. A token that cannot fetch a profile is one that will fail at the
  // first Connect, long after whoever pasted it has gone.
  const who = await identify({ id: '', kind: LoginKind.MojangToken, token: raw }, '')

  await store.adopt({ kind: LoginKind.MojangToken, token: raw, username: who.username, uuid: who.uuid })

  return [
    added(`${accent(who.username)} (${who.uuid})`),
    note('this kind cannot be renewed and will stop working in about a day'),
  ]
}

async function piped(): Promise<string> {
  process.stderr.write('Paste the Minecraft session token, then press ctrl-d:\n')

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)

  return Buffer.concat(chunks).toString('utf8').trim()
}

/** What this host holds, and who has it. Never what it is. */
function list(store: AccountStore, file: string): Report {
  const entries = store.summary()

  if (entries.length === 0) {
    return [note(`nothing in ${file}`), note("add one with 'osmium-link microsoft'")]
  }

  return [
    ...table(
      ['ID', 'KIND', 'ACCOUNT', 'AGENT'],
      entries.map((entry) => [
        entry.id,
        entry.kind,
        entry.username ?? '-',
        entry.agent === undefined ? '-' : String(entry.agent),
      ]),
    ),
    '',
    note(`${entries.length} in ${file}; a dash under AGENT means nothing is using it yet`),
  ]
}

/** Drops one credential. Bound or not - the operator can see which from `list`, and an account they
 * no longer have is worth removing whoever was using it. */
async function remove(store: AccountStore, id: string | undefined, ask: (() => Screen) | undefined): Promise<Report> {
  let wanted = id

  if (!wanted) {
    const entries = store.summary()
    if (entries.length === 0) throw new Error('there are no accounts to remove')
    if (!ask) throw new Error("name the id: there is no terminal to ask at - run 'osmium-link list' for them")

    wanted = await menu(
      ask(),
      'accounts',
      'Which account should go?',
      entries.map((entry) => ({
        label: entry.username ?? entry.id,
        value: entry.id,
        hint: `- ${entry.kind}${entry.agent === undefined ? '' : `, used by agent ${entry.agent}`}`,
      })),
    )
  }

  if (!(await store.remove(wanted))) return [note('nothing here with that id')]

  return [removed(wanted), note('restart the router if an agent was using it')]
}

// ---- odds and ends ------------------------------------------------------------------------------

/** Which flags a script left out, named so the fix is on the command line it came from. */
function missing(given: Record<string, string | undefined>): string {
  const absent = Object.entries(given)
    .filter(([key, value]) => value === undefined && key !== 'username')
    .map(([key]) => `--${key}`)

  return `${absent.join(', ')} ${absent.length > 1 ? 'are' : 'is'} needed when there is no terminal to ask at`
}

/**
 * Why there was nothing to draw on, and what to do about it.
 *
 * **Git Bash is the case worth naming.** Its terminal is a pipe as far as a Windows program is
 * concerned, so node reports no TTY, raw mode is unavailable and the wizard refuses - which looks
 * exactly like the tool exiting the moment it starts. `winpty` is the wrapper that gives it a real
 * console, and Windows Terminal or PowerShell need no wrapper at all.
 */
function noTerminal(): string {
  const which = [
    process.stdin.isTTY === true ? undefined : 'stdin',
    process.stdout.isTTY === true ? undefined : 'stdout',
  ].filter(Boolean)

  const why = which.length
    ? `${which.join(' and ')} ${which.length > 1 ? 'are' : 'is'} not a terminal`
    : 'this terminal cannot be put into raw mode'

  return (
    `Nothing to draw on: ${why}.\n\n` +
    'In Git Bash (mintty), Windows hands node a pipe rather than a console. Either run it as\n\n' +
    '  winpty osmium-link\n\n' +
    'or use Windows Terminal or PowerShell, where it works unwrapped. Every command also takes\n' +
    'flags, which need no terminal at all:\n\n' +
    USAGE
  )
}

/** Pulls `--name <value>` out of the arguments wherever it appears, so it can follow the command
 * rather than having to precede it. */
function take(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at === -1) return undefined

  const value = args[at + 1]
  if (value === undefined) {
    process.stderr.write(`${name} needs a value\n`)
    process.exit(2)
  }

  args.splice(at, 2)
  return value
}

main().catch((err) => {
  // Backing out is not a failure. Esc at a screen and ctrl-c both land here, and neither deserves
  // an error line - the operator knows what they did.
  if (err instanceof Cancelled) process.exit(0)

  log.error(reason(err))
  process.exit(1)
})
