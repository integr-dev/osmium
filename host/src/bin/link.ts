#!/usr/bin/env node
/**
 * Adds accounts to a host's account store, from the command line.
 *
 * **The interface is the normal way.** Choosing "Sign in with Microsoft" when setting an agent up
 * does the same sign-in and puts the code in that agent's activity feed - no shell, no container
 * access, nothing to run on the machine.
 *
 * This is for what the interface cannot reach: a host not enrolled yet, a backend that is down,
 * loading several accounts before any agent exists to use them, and the one credential kind nothing
 * can acquire - a Minecraft session token. It shares its flow and its store with the interface, so
 * an account added here is an account added there.
 *
 * **Safe to run while the router is running.** Both hold the same file, and every write is a locked
 * read-modify-write against what is on disk rather than a dump of what the process last saw.
 */
import { log, reason } from '../log.ts'
import { identify, signIn } from '../token/auth.ts'
import { LoginKind } from '../token/login.ts'
import { accountsPath, cachePath } from '../token/paths.ts'
import { AccountStore } from '../token/store.ts'

const USAGE = `osmium-link - add Minecraft accounts to this host

  osmium-link microsoft          sign in with Microsoft and keep the account
  osmium-link token              add a Minecraft session token, read from stdin
  osmium-link list               show what this host holds
  osmium-link remove <id>        drop one credential

  --file <path>                  the account store, default /agent/accounts.json
  --cache <path>                 the Microsoft token cache, default /agent/msa
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const file = take(args, '--file') ?? accountsPath()
  const cache = take(args, '--cache') ?? cachePath()

  // Opened before anything is asked of the operator, so a store that cannot be read is discovered
  // now rather than after they have approved something there is nowhere to keep.
  const store = await AccountStore.open(file)

  switch (args[0]) {
    case 'microsoft':
      return microsoft(store, cache)

    case 'token':
      return token(store)

    case 'list':
      return list(store, file)

    case 'remove':
      return remove(store, args[1])

    default:
      if (args[0]) process.stderr.write(`Unknown command '${args[0]}'.\n\n`)
      process.stderr.write(USAGE)
      process.exit(2)
  }
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

/** The device code flow: the operator approves in their own browser, and this never sees a
 * password. */
async function microsoft(store: AccountStore, cache: string): Promise<void> {
  const acquired = await signIn(cache, (code) => {
    say('')
    say(`  Open  ${code.url}`)
    say(`  Code  ${code.code}`)
    say('')
    say(`  Waiting for approval. The code expires in ${Math.round(code.expiresIn / 60)} minutes.`)
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
  say('')
  say(`  Linked ${acquired.username} (${acquired.uuid})`)
  say("  Set an agent up with 'Stored Microsoft account' to use it.")
}

/**
 * A Minecraft session token, which nothing in Osmium can obtain - so this is the only way one gets
 * onto a host.
 *
 * **Read from stdin, never an argument.** A token on a command line is in the shell history and in
 * `ps` for every other user on the machine for as long as this runs.
 */
async function token(store: AccountStore): Promise<void> {
  process.stderr.write('Paste the Minecraft session token, then press ctrl-d:\n')

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) throw new Error('no token given')

  // Checked before it is written. A token that cannot fetch a profile is one that will fail at the
  // first Connect, long after whoever pasted it has gone.
  const who = await identify({ id: '', kind: LoginKind.MojangToken, token: raw }, '')

  await store.adopt({ kind: LoginKind.MojangToken, token: raw, username: who.username, uuid: who.uuid })

  say('')
  say(`  Added ${who.username} (${who.uuid})`)
  say('  This kind cannot be renewed and will stop working in about a day.')
}

/** What this host holds, and who has it. Never what it is. */
function list(store: AccountStore, file: string): void {
  const entries = store.summary()

  if (entries.length === 0) {
    say(`No accounts in ${file}.`)
    say("Add one with 'osmium-link microsoft'.")
    return
  }

  say(`${'ID'.padEnd(38)}  ${'KIND'.padEnd(14)}  ${'ACCOUNT'.padEnd(18)}  AGENT`)

  for (const entry of entries) {
    const agent = entry.agent === undefined ? '-' : String(entry.agent)
    say(`${entry.id.padEnd(38)}  ${entry.kind.padEnd(14)}  ${(entry.username ?? '-').padEnd(18)}  ${agent}`)
  }

  say('')
  say(`${entries.length} accounts in ${file}. A dash under AGENT means nothing is using it yet.`)
}

/** Drops one credential. Bound or not - the operator can see which from `list`, and an account they
 * no longer have is worth removing whoever was using it. */
async function remove(store: AccountStore, id: string | undefined): Promise<void> {
  if (!id) throw new Error("which one? run 'osmium-link list' for the ids")

  if (await store.remove(id)) {
    say(`Removed ${id}.`)
    say('Restart the router if an agent was using it.')
  } else {
    say('Nothing here with that id.')
  }
}

/** Everything an operator is meant to read goes to stdout; the running commentary goes to stderr. */
function say(line: string): void {
  process.stdout.write(`${line}\n`)
}

main().catch((err) => {
  log.error(reason(err))
  process.exit(1)
})
