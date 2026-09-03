import { USERNAME } from './sender.ts'

/**
 * Commands an operator can give an agent from inside the game.
 *
 * **Chat is an untrusted channel and this is the only thing in the host that acts on what it says.**
 * Everything else the host does arrives over the authenticated socket from the backend; this
 * arrives from whoever is standing in a Minecraft server typing. So the rules are deliberately
 * narrow and the surface is deliberately small.
 *
 * The shape is `!osm [account] <command> [args…]`. Naming an account addresses one agent; leaving it
 * out addresses every agent that heard the line, which is every one of ours on that server.
 */
export const PREFIX = '!osm'

/**
 * How far a trusted player is trusted.
 *
 * **Two powers, not one.** Asking an agent about itself and *using* an agent are different things,
 * and a list with one level forces the operator to grant both to get either. `chat` is the tier
 * somebody gets for being in the list at all: it asks questions and gets answers about the agent, and
 * plays with the toys. `commands` additionally lets them run server commands through the agent,
 * under whatever permissions its Minecraft account holds — and put words of their choosing in its
 * mouth.
 *
 * `commands` is close to handing over the account. Anyone holding it on an operator bot can `/op`
 * themselves, and nothing here can tell that apart from an intended `/tp`.
 *
 * **`say` is on that side too**, which is not obvious, because it only talks. What it says is
 * arbitrary and it says it under an account you own: the room reads it as the account's owner, and
 * enough of it is a mute or a ban, which is the one consequence here that cannot be undone. The
 * agent's own readings are fixed sentences about itself and carry neither risk, which is what
 * separates them.
 */
export const TRUST = { chat: 'chat', commands: 'commands' } as const

export type Trust = (typeof TRUST)[keyof typeof TRUST]

/**
 * What a player on the list may do.
 *
 * Two shapes, because there are two ways to answer and both earn their place. A **tier** is the
 * broad answer - "chat things" or "everything" - and is what most entries are: it reads at a glance
 * and it does not need revisiting when a command is added here. A **list** is the exact answer, for
 * the player who should have one command out of the powerful tier and none of the others.
 *
 * A list is exact in both directions: it grants what it names and refuses everything else, the chat
 * commands included. Anything less would make "only `run`" quietly mean "`run` and the harmless
 * ones", which is not what somebody naming commands one at a time asked for.
 */
export type Grant =
  | { kind: 'tier'; tier: Trust }
  | { kind: 'only'; commands: ReadonlySet<string> }

/** Written after the colon when a grant names no commands at all, which is a real thing to mean. */
export const NOTHING = 'none'

/** Whether [grant] reaches [command]. The whole of the trust check, and the only place it is made. */
export function allows(grant: Grant | undefined, command: string): boolean {
  if (grant === undefined) return false
  if (grant.kind === 'only') return grant.commands.has(command)
  if (grant.tier === TRUST.commands) return isCommand(command)

  // A command this build cannot name is refused on the chat tier rather than assumed harmless.
  return COMMANDS[command as CommandName]?.needs === TRUST.chat
}

/**
 * What was written after the colon, read into a grant.
 *
 * A word that is not a tier is a **list of one**, not a tier this build guessed at. Falling back to
 * `chat` there would grant every harmless command to an entry that plainly asked for something
 * else - and since a command that cannot be named is refused, a list of nonsense grants nothing.
 */
export function grantFrom(written: string | undefined): Grant {
  if (written === undefined || written === '') return { kind: 'tier', tier: TRUST.chat }
  if (written === TRUST.commands) return { kind: 'tier', tier: TRUST.commands }
  if (written === TRUST.chat) return { kind: 'tier', tier: TRUST.chat }
  if (written === NOTHING) return { kind: 'only', commands: new Set() }

  return { kind: 'only', commands: new Set(written.split('+').filter((word) => word.length > 0)) }
}

/** How a grant reads in a log line, which is the only place an operator sees this spelled out. */
export function grantLabel(grant: Grant | undefined): string {
  if (grant === undefined) return 'nothing'
  if (grant.kind === 'tier') return grant.tier
  return grant.commands.size ? [...grant.commands].join('+') : NOTHING
}

/**
 * The commands this build answers, and how each one is written.
 *
 * **A table rather than a list, so `help` is generated from it.** Help that is maintained separately
 * from the commands is help that goes stale the first time somebody is in a hurry — and it goes
 * stale silently, because nothing fails. Adding a command here is the whole of adding a command:
 * the parser accepts it, `help` lists it, and the only thing left is what it does.
 *
 * `disrupts` says whether it is refused while the agent is holding a build segment, and the
 * `satisfies` below is what makes answering it compulsory — a command added without it does not
 * compile. `run` is why it exists at all: it hands somebody an arbitrary server command, so a
 * `/tp` typed in chat can take a builder off its box mid-segment. `disconnect` and `reconnect` end
 * the session under it. The rest only read, or talk — `say` included, which needs `commands` but
 * does not disrupt: talking does not take a builder off its box.
 *
 * Ordered by tier, because `help` is rendered in this order and a reader should not have to check
 * each name against the list of what they are allowed.
 *
 * A first word that is not one of these keys is read as an account instead.
 */
export const COMMANDS = {
  id: { args: '', needs: 'chat', disrupts: false },
  ping: { args: '', needs: 'chat', disrupts: false },
  health: { args: '', needs: 'chat', disrupts: false },
  food: { args: '', needs: 'chat', disrupts: false },
  uptime: { args: '', needs: 'chat', disrupts: false },
  help: { args: '', needs: 'chat', disrupts: false },
  '8ball': { args: '<question>', needs: 'chat', disrupts: false },
  cf: { args: '', needs: 'chat', disrupts: false },
  roll: { args: '[sides]', needs: 'chat', disrupts: false },
  say: { args: '<message>', needs: 'commands', disrupts: false },
  run: { args: '<command>', needs: 'commands', disrupts: true },
  disconnect: { args: '', needs: 'commands', disrupts: true },
  reconnect: { args: '', needs: 'commands', disrupts: true },
} as const satisfies Record<string, { args: string; needs: Trust; disrupts: boolean }>

/** Minecraft refuses a chat message longer than this, and a server usually kicks for trying. */
const SAY_MAX = 256

/**
 * The twenty answers a Magic 8-Ball gives, in its own order: ten yes, five maybe, five no.
 *
 * **Fixed strings, and the question is never repeated back.** Echoing it would make `8ball` a second
 * way to put a stranger's words in an agent's mouth — which is what `say` is, with a guard on it
 * that this would not have. The answer is the whole point of the toy anyway; the question was
 * rhetorical.
 */
export const EIGHT_BALL = [
  'it is certain',
  'it is decidedly so',
  'without a doubt',
  'yes definitely',
  'you may rely on it',
  'as I see it, yes',
  'most likely',
  'outlook good',
  'yes',
  'signs point to yes',
  'reply hazy, try again',
  'ask again later',
  'better not tell you now',
  'cannot predict now',
  'concentrate and ask again',
  "don't count on it",
  'my reply is no',
  'my sources say no',
  'outlook not so good',
  'very doubtful',
] as const

/**
 * The three below take their randomness as an argument rather than reaching for `Math.random`.
 *
 * Not ceremony: a coin that comes up heads half the time is the entire behaviour, and a function
 * that rolls its own dice can only be tested by rolling it a thousand times and hoping. Passing the
 * number in makes each of them a table of inputs to outputs, and leaves the one call to `Math.random`
 * where it belongs, at the edge.
 *
 * `chance` is in [0, 1), as `Math.random` returns.
 */
export function eightBall(chance: number): string {
  return EIGHT_BALL[Math.min(EIGHT_BALL.length - 1, Math.floor(chance * EIGHT_BALL.length))]!
}

export function coinFlip(chance: number): string {
  return chance < 0.5 ? 'heads' : 'tails'
}

/** A die with this many sides when nobody says otherwise, and the most one may ask for. */
const DIE = 6
const SIDES_MAX = 1000

/**
 * A roll of `[sides]`, defaulting to six.
 *
 * **Anything unreadable is a six rather than a refusal.** `!osm roll d20` and `!osm roll twenty` are
 * somebody reaching for the obvious thing, and answering the common case beats explaining the syntax
 * to a room. One-sided and negative dice are the same case: not a number of sides.
 *
 * Capped, because the answer goes into chat and a die with a million sides is a number nobody asked
 * to read.
 */
export function rolled(words: string[], chance: number): { sides: number; face: number } {
  const asked = Number(words[0])
  const sides =
    Number.isInteger(asked) && asked >= 2 && asked <= SIDES_MAX ? asked : DIE

  return { sides, face: Math.min(sides, Math.floor(chance * sides) + 1) }
}

export type CommandName = keyof typeof COMMANDS

/**
 * Every command, on one line.
 *
 * One line rather than one message each: a fleet answers `help` once per agent, so three commands
 * across four agents would be twelve messages and a spam kick. Usage only, no descriptions - chat is
 * 256 characters and a name plus its arguments is what somebody needs to type the next thing.
 */
export function helpLine(held: Grant | undefined): string {
  const usages = Object.entries(COMMANDS)
    // Only what the asker could actually use. A chat-only player shown `run` would be reading about
    // a power they will be silently refused, and it advertises the escalated command to the room.
    .filter(([name]) => allows(held, name))
    .map(([name, { args }]) => (args ? `${name} ${args}` : name))

  return `${PREFIX} [account] ${usages.join(' | ')}`
}

/**
 * What an agent may be made to run, or nothing when there is nothing to run.
 *
 * **A leading `/` is preserved rather than normalised away.** `//set stone` is WorldEdit, not a typo,
 * and a helpful cleanup that collapsed the two slashes would quietly run a different command than the
 * one that was typed. Anything not already starting with one gets exactly one, so `run tp me` and
 * `run /tp me` both mean the same thing.
 *
 * No filtering of *which* command. There is no list of safe ones — `/tp` is fine until the agent is
 * an operator and somebody sends it into a vault — so the decision is the trust tier, made once by
 * the operator, rather than a guess made here per command.
 */
export function runnable(words: string[]): string | undefined {
  const typed = words.join(' ').trim()
  if (!typed) return undefined

  return (typed.startsWith('/') ? typed : `/${typed}`).slice(0, SAY_MAX)
}

export interface ChatCommand {
  /** The account this was addressed to, or undefined when it was addressed to everybody. */
  account: string | undefined
  name: CommandName
  args: string[]
}

/**
 * Reads a chat line as a command, or answers nothing.
 *
 * **The first word decides what it is, and a known command name wins.** `!osm id` is the `id`
 * command asked of everybody rather than a command asked of an agent called `id` — the alternative
 * needs a lookup this side cannot do for agents on other hosts, and an operator typing the common
 * case must not have to name themselves out of an ambiguity they cannot see.
 *
 * The consequence is written down rather than hidden: an agent whose Minecraft account is called
 * `id` cannot be addressed by name. Nothing else about it stops working.
 *
 * Returns nothing for anything it is not certain about. A line that merely mentions the prefix, a
 * command this build does not have, an account name that could not be one - all of them are chat.
 */
export function commandIn(message: string): ChatCommand | undefined {
  const words = message.trim().split(/\s+/)

  // Anchored at the start of the line. A line that quotes the prefix inside a sentence is somebody
  // talking about commands, not issuing one - and on a server that renders a rank in front, the
  // prefix never lands at position zero of anything a player did not type themselves.
  if (words[0] !== PREFIX) return undefined

  const [first, ...rest] = words.slice(1)
  if (first === undefined) return undefined

  if (isCommand(first)) return { account: undefined, name: first, args: rest }

  // `@name` as well as `name`. Addressing somebody with an `@` is what chat has taught everybody to
  // do, and refusing it teaches nothing - the first person to try it typed `!osm @intemeow id`.
  const account = first.startsWith('@') ? first.slice(1) : first

  // Not a command, so it is meant to be an account - and if it could not be one, this is not a
  // command at all rather than a command aimed at nobody.
  if (!USERNAME.test(account)) return undefined

  const [name, ...args] = rest
  if (name === undefined || !isCommand(name)) return undefined

  return { account, name, args }
}

/**
 * What an agent may be made to say, or nothing when it may not be made to say it.
 *
 * Two refusals, both about the difference between an agent repeating a sentence and an agent being
 * used as a weapon by somebody who was only trusted with chat.
 *
 * **Nothing beginning with `/`.** Minecraft would run it as a server command, under whatever
 * permissions the agent's account holds — so a player trusted to make a bot talk would also be able
 * to make an operator bot `/op` them. Speaking and acting are different powers and this one is
 * speech. A separate command can be added for the other, with its own list and its own argument.
 *
 * **Nothing beginning with the prefix.** An agent saying `!osm …` is a command in the room, heard by
 * every other agent; whether it loops then depends on whose account is trusted, which is exactly the
 * kind of thing that is easy to get wrong once and hard to notice. Cutting it here means it cannot
 * happen however the list is configured.
 *
 * Truncated rather than refused when it is too long: the operator's sentence mostly arrives, which
 * beats silence for a message that was one word over.
 */
export function sayable(words: string[]): string | undefined {
  const message = words.join(' ').trim()
  if (!message) return undefined

  if (message.startsWith('/')) return undefined
  if (message.startsWith(PREFIX)) return undefined

  return message.slice(0, SAY_MAX)
}

/** Whether this line is addressed to an agent playing [account]. */
export function addressedTo(command: ChatCommand, account: string | undefined): boolean {
  if (command.account === undefined) return true
  if (account === undefined) return false

  // Minecraft compares names case-insensitively, and an operator typing one into chat is not
  // checking their capitals.
  return command.account.toLowerCase() === account.toLowerCase()
}

/** Whether a word is a command this build answers. Exported for {@link allows}. */
/** Whether a command must wait until the agent has finished the segment it is holding. */
export function disruptsBuilding(command: string): boolean {
  return COMMANDS[command as CommandName]?.disrupts === true
}

export function isCommand(word: string): word is CommandName {
  return Object.hasOwn(COMMANDS, word)
}
