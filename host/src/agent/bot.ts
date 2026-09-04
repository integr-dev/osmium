import minecraftData from 'minecraft-data'
import minecraftProtocol from 'minecraft-protocol'
import mineflayer, { type Bot, type BotOptions } from 'mineflayer'

import { type Endpoint, locate } from './address.ts'
import { type Component, componentsOf } from './chat.ts'
import {
  addressedTo,
  disruptsBuilding,
  allows,
  coinFlip,
  commandIn,
  eightBall,
  grantFrom,
  grantLabel,
  helpLine,
  rolled,
  runnable,
  sayable,
  type Grant,
} from './command.ts'
import {
  compile,
  SERVER,
  senderOf,
  spokenIn,
  USERNAME,
  VANILLA,
  WHISPER,
  WHISPER_COMMAND,
  whisperWith,
  WHISPER_SENT,
} from './sender.ts'

import {
  AgentInventory,
  DROP_CLICK,
  DROP_ONE,
  DROP_STACK,
  HOTBAR_FIRST,
  holdable,
  movable,
} from './inventory.ts'
import { AgentMap, worldOf } from './map.ts'
import {
  AgentUtilities,
  antiHungerFrom,
  distanceFrom,
  modeFrom,
  type AntiHunger,
  type Mode,
} from './utility.ts'
import { AgentViewer } from './viewer.ts'

import { log, reason } from '../log.ts'
import { routed, type Proxies, type ProxyEntry } from './proxy.ts'
import type { CommandBody, Event, SetupResult, Vitals } from '../protocol/message.ts'
import { ActivityScope, ChatScope, LoginState, type Player, Severity, type Vec3 } from '../protocol/wire.ts'
import { identify, type Identity, type LinkCode, NotSignedIn, signIn } from '../token/auth.ts'
import { LoginKind } from '../token/login.ts'
import type { AccountStore, Entry } from '../token/store.ts'
import { VERSION } from '../version.ts'

/** How often the vitals are sampled while an agent is in game.
 *
 * The backend holds them in memory and lets them go stale after thirty seconds, so this is the rate
 * that keeps them current rather than a rate anything is waiting on. */
const VITALS = 5_000

/** How long a server gets to say anything at all before the attempt is given up on.
 *
 * The backend allows ninety seconds for a `connect` and then declares the agent no longer
 * connecting, so this answers well inside that - an operator is owed a reason rather than a
 * timeout somebody else declared. */
const CONNECTING = 30_000

/** How long after joining to check that the world actually arrived. Long enough for a slow server
 * to send its first chunks, short enough that a stuck agent is called out while somebody is still
 * looking at it. */
const GROUNDED = 15_000

/** How long to wait on a status ping before assuming the server will not answer one. */
const PING = 8_000

/** How long to wait for the server's account of a death before reporting it without one.
 *
 * mineflayer raises `death` off the health packet and the sentence explaining it is a separate one,
 * so the two race. Long enough that they land together, short enough that nobody notices the feed
 * was a quarter of a second behind. */
const OBITUARY = 250

/** What to assume when a server will not answer a version check. The newest this build speaks, which
 * is what a fixed-version client would have used. */
const ASSUMED = mineflayer.latestSupportedVersion

/**
 * The most to report at once.
 *
 * Everyone the client can see is reported - see {@link nearby} - so this is not a range but a
 * ceiling, and one nothing reasonable reaches: a server that fits two hundred players inside one
 * agent's render distance is a spawn lobby, not a build site. The list is sorted by distance, so if
 * it ever does bite, what it cuts is what matters least.
 */
const NEARBY_LIMIT = 200

/** How an agent reaches the rest of the host. */
export interface AgentHooks {
  event(event: Event): void
  /** One batch of world updates, for whoever is watching this agent.
   *
   * Not an {@link Event}: it carries nothing the backend keeps, and it is binary, so it neither
   * fits the JSON envelope nor should be parsed by anything in the middle. The backend relays it
   * to the browsers watching this agent and stores none of it. */
  viewer(frame: Buffer): void
  /** Answers the `setup_agent` that asked for this agent. Called at most once, and never for an
   * agent rebuilt from the store - nothing asked for that one. */
  result(setup: SetupResult): void
  /** This agent will do nothing further and can be forgotten. */
  finished(): void
}

/** What an agent has been given to log in with.
 *
 * Three shapes because they are settled at different moments. A stored credential is taken from the
 * store the instant the command arrives, and running out of them is an immediate, honest failure.
 * An interactive one does not exist yet: it is created by a person approving something, minutes
 * later, in a browser this host cannot see. A restored one was read back from the store on start,
 * and owes no answer because nobody asked for it. */
export type Credential =
  | { kind: 'stored'; entry: Entry }
  | { kind: 'device_code' }
  | { kind: 'restored'; entry: Entry }

/**
 * One agent, from the moment it has credentials to the moment the process ends.
 *
 * **Everything it reports is an event, not an answer.** The only command that gets a result is the
 * setup - the rest are fire and forget, and their outcome reaches the backend as a state change.
 * That is the rule the whole protocol turns on: state advances when the host says so, not when the
 * backend asks.
 */
export class Agent {
  private bot: Bot | undefined
  private entry: Entry | undefined
  private identity: Identity | undefined
  private listening = false
  /** Set the moment a disconnect arrives, so an attempt already under way can abandon itself. */
  private cancelling = false
  /** Whether somebody has a viewer open on this agent. Survives a reconnect within one session so
   * a watcher does not go blank when the agent rejoins; cleared when the backend says nobody is
   * watching any more, or when this agent is finished with. */
  private watched = false
  /** Runs only while {@link watched} and in game. Rebuilt per session: it holds the bot. */
  private watcher: AgentViewer | undefined
  /** Runs for every session, watched or not: the map is worth having drawn before anyone asks for
   * it. Rebuilt per session, like the watcher, because it holds the bot. */
  private mapper: AgentMap | undefined
  private carrying: AgentInventory | undefined

  /**
   * The segments this host has been handed for this agent and not been told to drop.
   *
   * Tracked even though this build cannot place a block yet, and not as a placeholder for that: the
   * backend genuinely hands segments out, and holding one is already the fact that decides whether
   * an action is safe. Once building lands this is the state it works from rather than a second
   * one beside it.
   */
  private readonly segments = new Set<number>()
  /**
   * The name of the world this session is standing in, as the server calls it.
   *
   * Read off the raw packets because mineflayer deliberately does not keep it: `bot.game.dimension`
   * is the dimension *type*, which it needs for its own codec lookups. A server running Multiverse
   * has many worlds of type `overworld`, and the map has to tell them apart - see `worldOf`.
   */
  private level: string | undefined
  /** Whether this session ever got in. `spawn` fires again on every respawn and every dimension
   * change, and an agent that died has not rejoined the server. */
  private joined = false
  /** Set while we are the ones ending the session, so its `end` is not reported as the server
   * dropping us. */
  private leaving = false
  /** Whether the server already said why it was ending this session, so `end` does not put the same
   * failure in the operator's feed a second time under a vaguer heading. */
  private kicked = false
  /** The last thing that actually went wrong on this session.
   *
   * `end` names a state - `socketClosed` - rather than a cause, and it is the only thing reported
   * for everything that is not a kick. So the error that preceded it is kept and used instead: an
   * operator who mistypes an address is owed "could not find play.example.net", not "socketClosed".
   */
  private failure: string | undefined
  /** Whether this session has already been accounted for.
   *
   * A failed attempt can arrive as an `error`, as an `end`, as both, or - when the version ping is
   * what failed - as an `error` and nothing else ever. So every one of them settles the session and
   * the first to arrive wins. */
  private settled = true
  /** Gives up on a server that accepts the connection and then says nothing. */
  private watchdog: NodeJS.Timeout | undefined
  /** The translation table for the version this session negotiated, for turning a server's
   * translation keys into sentences. Empty until a session is open, and empty is survivable: an
   * unresolved key reads as the key, which is ugly rather than wrong. */
  private language: Record<string, string> = {}
  /** How this agent's server writes a speaker's name into a chat line. Undefined means vanilla,
   * which is what an unconfigured agent gets - see `senderOf`. */
  private chatSender: RegExp | undefined
  /** How this agent's server writes a whisper addressed to it. Undefined means vanilla. */
  private chatWhisper: RegExp | undefined
  /** How this agent's server writes a whisper it sent. Undefined means vanilla. */
  private chatWhisperSent: RegExp | undefined
  /** The version to speak, when an operator has pinned one. Undefined means ask the server, which
   * is what an unconfigured agent does - see `negotiate`. */
  private version: string | undefined
  /** The name of the proxy to route through, when an operator has picked one. Undefined connects
   * from this machine's own address, which is what an unconfigured agent does - see `connect`. */
  private proxy: string | undefined
  /** Whether to undo mineflayer's velocity scaling. Undefined means decide from the version, which
   * is what an unconfigured agent does - see `absoluteVelocity`. */
  private knockback: boolean | undefined
  /** Whether to be pushed around at all. Undefined means yes, which is what a Minecraft client does.
   * Turning it off makes the correction above irrelevant, since nothing is applied either way. */
  private takeKnockback: boolean | undefined

  /** The utility modules, as configured. Read live by [utilities], never captured. */
  private noFall = false
  private antiHunger: AntiHunger = 'off'
  private autoEat: Mode = 'off'
  private autoTotem: Mode = 'off'
  private fleeDistance = 0

  /** Attached per session, like the mapper and the inventory reporter. */
  private utilities: AgentUtilities | undefined
  /** The server's own command for sending a private message, as a template. Undefined means `/msg`,
   * which is what vanilla and most plugin suites answer to - see `WHISPER_COMMAND`. */
  private whisperCommand: string | undefined
  /** Where to go once this session has finished ending. Set by a `reconnect`. */
  private returning: string | undefined
  /**
   * Who may command this agent from inside the game, lower-cased.
   *
   * **Empty means nobody.** An unset setting has to be the safe answer, and on a public server the
   * unsafe answer is every stranger standing in spawn. An agent nobody has put a name on simply does
   * not take chat commands.
   *
   * A map rather than a set, because being in the list is not one power: see {@link Trust}. An entry
   * with no tier written on it is trusted for chat only.
   */
  private trusted = new Map<string, Grant>()
  /**
   * What this session is, for the sentences written about it after it ends.
   *
   * `ended` is handed a cause and nothing else, so without this an operator is told a connection
   * failed without being told which one, or to what. `joinedAt` is set on the first spawn and stays
   * unset for an attempt that never got in - which is exactly the distinction between "kicked after
   * six hours" and "refused on the way in".
   */
  private session: { address: string; version: string; joinedAt?: number } | undefined
  /** What the server said about the last death, if it said anything. Cleared as it is reported. */
  private obituary: string | undefined
  private vitals: NodeJS.Timeout | undefined
  private done = false

  /** Commands queue behind the login. A device code sign-in takes minutes, and a `connect` that
   * arrived during one has to be acted on afterwards rather than dropped. */
  private queue: Promise<unknown>

  constructor(
    readonly id: number,
    private readonly credential: Credential,
    private readonly store: AccountStore,
    private readonly cacheDirectory: string,
    /** Every proxy this host holds. Which one this agent uses is a setting - see `configure`. */
    private readonly proxies: Proxies,
    private readonly hooks: AgentHooks,
  ) {
    this.queue = this.begin().catch((err) => log.error(`Agent ${id} fell over while starting: ${reason(err)}`))
  }

  /** Hands a command to this agent, after everything already queued for it. */
  handle(command: CommandBody): void {
    // Noted now, before it takes its turn. A disconnect is usually cancelling the very command it
    // is queued behind - an operator who has seen an agent banned is not waiting out a login and
    // thirty seconds of watchdog to say stop - and `connect` reads this at every point it gives up
    // the thread.
    if (command.type === 'disconnect') this.cancelling = true

    this.queue = this.queue.then(() => this.run(command)).catch((err) => {
      log.warn(`Agent ${this.id} could not carry out ${command.type}: ${reason(err)}`)
    })
  }

  /** Acquires the credential, proves it, and says so. */
  private async begin(): Promise<void> {
    // Whether anybody is waiting on an answer. A restored agent was rebuilt from the store on
    // start, so no command asked for it and a `setup_result` would be replying to nothing.
    const owesResult = this.credential.kind !== 'restored'

    if (this.credential.kind === 'device_code') {
      const entry = await this.link()
      if (!entry) return this.give_up()
      this.entry = entry
    } else {
      this.entry = this.credential.entry
    }

    try {
      this.identity = await identify(this.entry, this.cacheDirectory)
    } catch (err) {
      // Written for whoever reads host logs. The operator only ever sees the agent go back to
      // UNLINKED so they can try again.
      log.warn(`Agent ${this.id} could not log in: ${reason(err)}`)

      if (owesResult) {
        this.hooks.result({ ok: false, reason: err instanceof NotSignedIn ? 'That account is no longer signed in' : 'Login was rejected' })
      } else {
        // Nobody asked, so there is nothing to answer - but a stored credential that has stopped
        // working is exactly what NEEDS_RELINK is for, and the operator would otherwise find out by
        // pressing Connect.
        this.report({ state: LoginState.NeedLinkCredentials })
      }

      return this.give_up()
    }

    // Noted so `osmium-link list` can name the account. Never the credential.
    await this.store.describe(this.entry.id, this.identity.username, this.identity.uuid)

    // The identity, and nothing else. A credential must never travel this way.
    if (owesResult) {
      this.hooks.result({ ok: true, mcUsername: this.identity.username, mcUuid: this.identity.uuid })
    }

    // Credentials held, not in game - the one thing that is true before anything is asked of us.
    this.report({ state: LoginState.LinkedCredentials })
  }

  private give_up(): void {
    this.done = true
    this.hooks.finished()
  }

  private async run(command: CommandBody): Promise<void> {
    if (this.done && command.type !== 'delete_agent') {
      log.warn(`Agent ${this.id} is not running, ignoring ${command.type}`)
      return
    }

    switch (command.type) {
      // Already answered. Setting up twice would acquire a second credential for an agent that has
      // one, and the backend never asks.
      case 'setup_agent':
        log.warn(`Agent ${this.id} is already set up`)
        return

      case 'connect':
        return this.connect(command.address)

      case 'disconnect':
        return this.disconnect()

      case 'chat':
        return this.say(command.message)

      case 'set_chat_listener':
        this.listening = command.enabled
        return

      case 'set_viewer':
        this.watch(command.enabled)
        return

      case 'settings':
        return this.configure(command.values)

      // All three move what the agent is placing from. See `busy`.
      case 'inventory_move':
        if (this.busy('inventory_move')) return
        return this.shift(command.from, command.to)

      case 'inventory_drop':
        if (this.busy('inventory_drop')) return
        return this.drop(command.slot, command.count)

      case 'inventory_hold':
        if (this.busy('inventory_hold')) return
        return this.hold(command.slot)

      // Placing is not built yet, and ignoring that half is the honest answer - reporting progress
      // on a box nobody is filling would be worse than silence. The segment is still *held*, which
      // is what makes the agent refuse anything that would disturb it.
      case 'build_segment':
        this.segments.add(command.segmentId)
        log.warn(`Agent ${this.id} cannot build yet, holding segment ${command.segmentId} idle`)
        return

      // Satisfied by never having started, and it stops being held either way.
      case 'cancel_segment':
        this.segments.delete(command.segmentId)
        return

      case 'delete_agent':
        return this.remove()
    }
  }

  /**
   * Whether the agent is in the middle of a segment, and therefore not to be disturbed.
   *
   * **Checked here as well as on the backend, which already refuses these.** Two reasons, and
   * neither is distrust: chat commands never pass through the backend at all, so this is the only
   * guard they have - and a host that relies on the far side having the right idea of what it is
   * doing is a host that does the wrong thing the moment the two disagree.
   *
   * Refusing is silent apart from the log. There is nobody to answer: a command arrives with no
   * result channel, and a chat command is answered by the caller.
   */
  private busy(what: string): boolean {
    if (this.segments.size === 0) return false

    log.warn(`Agent ${this.id} refused ${what}: building segment(s) ${[...this.segments].join(', ')}`)
    return true
  }

  private async connect(address: string): Promise<void> {
    if (this.bot) {
      log.warn(`Agent ${this.id} is already in game`)
      return
    }

    // Both settled before the session opens rather than by the library during it - see `locate` and
    // `negotiate`. The endpoint has to come first: the version check is a ping, and pinging the
    // wrong port answers about the wrong thing.
    if (this.abandoned()) return

    let endpoint
    try {
      endpoint = await locate(address)
    } catch (err) {
      // Nothing has opened yet, so no session will report this. Said here or not at all - and an
      // agent that reports nothing sits in CONNECTING until the backend gives up on it.
      log.warn(`Agent ${this.id} could not work out where ${address} is: ${reason(err)}`)
      this.activity(ActivityScope.System, Severity.Error, `Could not look up ${address}: ${reason(err)}`)
      this.report({ state: LoginState.FailedConnection })
      return
    }

    // A pinned version skips the ping entirely rather than checking the answer against it. That is
    // the point of pinning: the servers worth pinning for are the ones whose ping cannot be trusted
    // or cannot be had, so asking anyway would reintroduce exactly the failure being worked around.
    if (this.abandoned()) return
    if (this.version) log.debug(`Agent ${this.id}: speaking ${this.version} to ${address}, as configured`)

    /*
     * **Resolved before the first packet, and refused rather than fallen back from.**
     *
     * A proxy that is named and missing is the one case where carrying on is worse than failing:
     * the reason to route an agent through somewhere else is that this machine's own address must
     * not appear on that server, and a silent direct connection is exactly the thing being
     * prevented. So a name this host does not hold ends the attempt here.
     */
    let route: ProxyEntry | undefined
    if (this.proxy) {
      route = this.proxies.find(this.proxy)
      if (!route) {
        log.warn(`Agent ${this.id} names proxy '${this.proxy}', which this host does not hold`)
        this.activity(
          ActivityScope.System,
          Severity.Error,
          `Not connecting: this host has no proxy called '${this.proxy}'`,
        )
        this.report({ state: LoginState.FailedConnection })
        return
      }
      log.debug(`Agent ${this.id}: routing ${address} through '${route.name}' (${route.kind})`)
    }

    const version = this.version ?? (await negotiate(endpoint, this.id, route))
    if (this.abandoned()) return

    this.open(address, endpoint, version, route)
  }

  /**
   * Whether to stop where we are, because a disconnect arrived while this attempt was in flight.
   *
   * Checked wherever the attempt gives up the thread. Looking a server up and asking it its version
   * are both network round trips, and a session that has not opened cannot be quit - so without
   * this the only way to stop an agent joining is to let it join first.
   *
   * Reports where the agent actually is. Nothing else will: the backend holds it in CONNECTING
   * until something says otherwise, and an attempt that simply returned would leave it there until
   * the ninety-second timeout.
   */
  private abandoned(): boolean {
    if (!this.cancelling) return false

    log.info(`Agent ${this.id} stopped connecting: it was asked to`)
    this.activity(ActivityScope.Lifecycle, Severity.Info, 'Connection cancelled')
    this.report({ state: LoginState.LinkedCredentials })
    return true
  }

  /** Opens one session, on an endpoint and a version already decided, through a proxy or not. */
  private open(address: string, endpoint: Endpoint, version: string, route: ProxyEntry | undefined): void {
    if (!this.entry || !this.identity) return

    let bot: Bot
    try {
      bot = mineflayer.createBot({
        // Both given, so the library looks nothing up: we have already done it, and it would
        // resolve to somewhere else on a machine whose resolver cannot see SRV records.
        host: endpoint.host,
        port: endpoint.port,
        version,
        // Normally off: the library phrases its failures for a person watching a terminal, and
        // nobody is watching this one - we report what matters ourselves. But it swallows packet
        // parse failures rather than raising them, and a chunk that will not parse is invisible
        // otherwise, so anybody who asked for debug gets them.
        hideErrors: !log.debugging(),
        ...credentials(this.entry, this.identity, this.cacheDirectory),
        // Two options, one for each connection a join makes: `connect` opens the game socket and
        // `agent` carries the session-server call that proves the account is joining. Spread last
        // so neither can be written over by anything above.
        ...(route ? routed(route, endpoint.host, endpoint.port) : {}),
      } as BotOptions)
    } catch (err) {
      // Failing to resolve the address refuses us as surely as a whitelist would, and reads the same
      // way to an operator.
      log.warn(`Agent ${this.id} could not reach ${address}: ${reason(err)}`)
      this.activity(ActivityScope.System, Severity.Error, `Could not reach ${address}: ${reason(err)}`)
      this.report({ state: LoginState.FailedConnection })
      return
    }

    this.bot = bot
    this.leaving = false
    this.kicked = false
    this.joined = false
    this.settled = false
    this.failure = undefined
    this.obituary = undefined
    this.session = { address, version }
    this.language = languageOf(version)

    // A server can accept the connection and then say nothing at all - a queue that never moves, a
    // proxy with nothing behind it. Neither `error` nor `end` arrives for that, and the backend
    // gives up on the whole command after ninety seconds, so this answers well inside that.
    this.watchdog = setTimeout(() => this.ended('the server did not respond'), CONNECTING)

    this.listen(bot, address)
  }

  private listen(bot: Bot, address: string): void {
    /**
     * Ignores anything from a session this agent has already moved on from.
     *
     * A bot that has been settled can still emit - a callback already in flight, a socket closing
     * late - and its listeners are bound to this agent rather than to it. One did exactly that: a
     * dead attempt threw two milliseconds after its replacement had opened, and the replacement was
     * the one reported as having failed.
     */
    const live =
      <A extends unknown[]>(handler: (...args: A) => void) =>
      (...args: A) => {
        if (this.bot === bot) handler(...args)
      }

    /*
     * `login` as well as `spawn`, and this one first.
     *
     * `spawn` waits for a loaded chunk, which a lobby, a queue or a slow server can delay well past
     * the ninety seconds the backend allows for answering a `connect`. An agent that has received
     * the login packet is in the game, which is what ONLINE claims. Repeating a state unchanged is
     * explicitly harmless, so both report it and the later one costs nothing.
     */
    bot.on(
      'login',
      live(() => {
        clearTimeout(this.watchdog)
        this.watchdog = undefined

        this.report({ state: LoginState.Online })
      }),
    )

    bot.on(
      'spawn',
      live(() => {
        this.report({ state: LoginState.Online })

        // The world is there now, so a watcher that was waiting on this session can be served. On
        // a respawn or a dimension change the old one is holding chunks that no longer exist, so
        // it is rebuilt rather than left running.
        this.unwatch()
        if (this.watched) this.begin_watching()

        // The same rebuild, for the same reason: a dimension change puts the agent under a
        // different world, and a mapper that kept its "already sent this" memory across one would
        // report the Nether's ceiling as the Overworld's ground.
        this.begin_mapping()
        this.begin_carrying()
        this.begin_utilities()

        // Only the first one, and only one sampler. `spawn` fires again on every respawn and every
        // dimension change, and an agent that died has not rejoined the server.
        if (this.joined) return
        this.joined = true
        if (this.session) this.session.joinedAt = Date.now()

        // Everything an operator would otherwise have to go and look up: which server, under which
        // account, speaking what, and where it came out. The version is worth stating because it may
        // have been guessed - see `negotiate` - and a wrong guess shows up as odd behaviour later
        // rather than as a failure here.
        const place = placeOf(bot, this.level)
        this.activity(
          ActivityScope.Lifecycle,
          Severity.Info,
          `Joined ${address} as ${this.identity?.username ?? 'this agent'} on ${bot.version}` +
            (place ? `, at ${place}` : ''),
        )
        this.vitals = setInterval(() => this.sample(), VITALS)

        // Whether the world arrived, not just the login. Mineflayer runs no physics at all while the
        // block under an agent is unknown, and an agent without physics stands still through
        // knockback, gravity and everything else - while still reporting health, chat and who is
        // nearby, because none of those come from the world.
        setTimeout(() => this.grounded(), GROUNDED)
      }),
    )

    /*
     * What killed it, from the server's own account of it.
     *
     * mineflayer raises `death` off `update_health`, which carries a number and nothing else. The
     * sentence - "Mason_04 was slain by Zombie" - is a different packet, and the two arrive in no
     * guaranteed order. So the message is stashed as it lands and the report waits a moment for it.
     *
     * Reading the packet rather than writing anything, so unlike the velocity correction this does
     * not care when it was registered relative to mineflayer's own handlers.
     */
    bot._client.on('death_combat_event', (packet: { message?: unknown }) => {
      if (this.bot === bot) this.obituary = this.readable(packet.message)
    })

    // Both packets carry it, and both change which world the agent is in: `login` for the world it
    // joins, `respawn` for every one it moves to afterwards. Registered here, before either can
    // arrive, because the first is the only announcement the joining world ever gets.
    const named = (packet: unknown) => {
      const name = levelNameOf(packet)
      if (this.bot === bot && name) this.level = name
    }
    bot._client.on('login', named)
    bot._client.on('respawn', named)

    bot.on(
      'death',
      live(() => {
        // Read now, synchronously: mineflayer respawns immediately after this event, and by the time
        // the report is written the agent is standing somewhere else entirely.
        const place = placeOf(bot, this.level)

        setTimeout(() => {
          if (this.bot !== bot) return

          const cause = this.obituary
          this.obituary = undefined

          this.activity(
            ActivityScope.Lifecycle,
            Severity.Warning,
            `Died${place ? ` at ${place}` : ''}${cause ? `: ${cause}` : ''}`,
          )
        }, OBITUARY)
      }),
    )

    // Registered through a cast because mineflayer emits two arguments its published type does not
    // declare. The one after the component is the packet talking: `sender` is the speaker's uuid,
    // present only on real player chat. See `heard`.
    const onChat = bot.on.bind(bot) as unknown as (
      event: 'messagestr',
      handler: (message: string, position: string, json: unknown, sender: unknown) => void,
    ) => void

    onChat(
      'messagestr',
      live((message: string, position: string, json: unknown, sender: unknown) =>
        this.heard(message, position, json, typeof sender === 'string' ? sender : undefined),
      ),
    )

    // The server closed the session. The reason is the kick text, which is the one thing an operator
    // needs and would otherwise never see.
    bot.on(
      'kicked',
      live((kick: unknown) => {
        this.kicked = true

        // How long it lasted is half the diagnosis: refused on the way in, dropped after a minute,
        // or taken out of a session that had been running all afternoon.
        const joinedAt = this.session?.joinedAt
        const said = this.readable(kick)

        this.activity(
          ActivityScope.System,
          Severity.Warning,
          `Kicked${joinedAt ? ` after ${lasted(joinedAt)}` : ' before it got in'}` +
            (said ? `: ${said}` : ' (the server gave no reason)'),
        )
      }),
    )

    bot.on(
      'error',
      live((err: unknown) => {
        this.failure ??= explain(err, address)
        log.debug(`Agent ${this.id} on ${address}: ${reason(err)}`)

        // An error before we are in game ends the attempt, here, rather than waiting for `end` -
        // which does not always follow. Once we are in game the opposite holds: a stray error is not
        // a session ending, so those are left for `end` to settle.
        if (!this.joined) this.ended('the connection failed')
      }),
    )

    bot.on(
      'end',
      live((why: string) => this.ended(why)),
    )

    unscaleVelocity(bot, this.id, () => ({ take: this.takeKnockback, correct: this.knockback }))
  }

  /** Settles one session, whichever of the several endings arrived first. */
  private ended(why: string): void {
    if (this.settled) return
    this.settled = true

    clearTimeout(this.watchdog)
    clearInterval(this.vitals)
    this.watchdog = undefined
    this.vitals = undefined
    this.listening = false
    // The stream goes, the subscription stays: a watcher whose agent is reconnecting is still
    // watching, and gets the world back when the agent spawns into it.
    this.unwatch()
    this.unmap()
    this.uncarry()
    this.unutilities()
    // Whatever it was holding is the backend's again: leaving the game releases every segment, and
    // a set that outlived the session would refuse commands on behalf of work nobody is doing.
    this.segments.clear()

    // Torn down here, because we may have settled this before the protocol did - an attempt that
    // failed its version ping still holds an open socket nothing else will ever close.
    const bot = this.bot
    this.bot = undefined
    if (bot) close(bot, this.id)

    // Deleted while in game. Nothing is owed about an agent the backend has already been told to
    // forget.
    if (this.done) return

    const joined = this.joined
    const kicked = this.kicked
    // What went wrong, when anything said so. `why` is `socketClosed` for most of these, which
    // names the symptom and never the cause.
    const cause = this.failure ?? why
    const session = this.session

    this.joined = false
    this.kicked = false
    this.failure = undefined
    this.session = undefined

    // We asked for this, so there is nothing to announce - the operator pressed the button.
    if (this.leaving) {
      this.leaving = false
      this.report({ state: LoginState.LinkedCredentials })

      // A `reconnect` is a disconnect with a return ticket, and this is the first moment there is
      // nothing in the way of using it: the session is settled and `bot` is already undefined.
      const address = this.returning
      this.returning = undefined
      if (address) this.handle({ type: 'connect', address })

      return
    }

    if (joined) {
      // A session that existed and stopped. `kicked` has already said why when the server bothered
      // to say; this covers the rest - a dropped socket, a server that went away.
      if (!kicked) {
        const held = session?.joinedAt ? ` after ${lasted(session.joinedAt)}` : ''
        const where = session ? ` from ${session.address}` : ''

        this.activity(ActivityScope.System, Severity.Warning, `Dropped${where}${held}: ${cause}`)
      }
      this.report({ state: LoginState.LinkedCredentials })
      return
    }

    // Never got in. That refuses us as surely as a kick would, and reads the same way to an
    // operator. Naming the version matters here more than anywhere: an attempt that fails on a
    // version this host guessed at is a different problem from one that fails on a version an
    // operator pinned, and the message is the only place the guess is ever visible.
    if (!kicked) {
      const tried = session ? ` ${session.address} speaking ${session.version}` : ''

      this.activity(ActivityScope.System, Severity.Error, `Could not join${tried}: ${cause}`)
    }
    this.report({ state: LoginState.FailedConnection })
  }

  private disconnect(): void {
    this.cancelling = false

    // No session, so there is nothing to quit - but an attempt may have just abandoned itself on
    // our account, and the backend is holding this agent in CONNECTING until somebody says
    // otherwise. Saying where it actually is costs nothing when it was already there.
    if (!this.bot) {
      this.report({ state: LoginState.LinkedCredentials })
      return
    }

    this.leaving = true
    this.bot.quit()
  }

  /**
   * Takes the configuration for this agent.
   *
   * **The whole set, every time.** A key that is absent has been cleared, not left alone - so each
   * setting is read fresh rather than merged into what was there, and turning one back off works.
   *
   * A key this build does not know is ignored, deliberately. The list of settings is declared by the
   * interface, so an operator on a newer Osmium than this host is ordinary rather than an error, and
   * the alternative - refusing the whole message - would lose the settings it *does* understand
   * alongside the one it does not.
   */
  private configure(values: Record<string, string>): void {
    const known = new Set([
      'chat.sender',
      'chat.whisper',
      'chat.whisperSent',
      'chat.whisperCommand',
      'mc.version',
      'mc.knockback',
      'mc.takeKnockback',
      'players.whitelist',
      'util.noFall',
      'util.antiHunger',
      'util.autoEat',
      'util.autoTotem',
      'util.fleeDistance',
      'connect.proxy',
    ])
    const unknown = Object.keys(values).filter((key) => !known.has(key))

    if (unknown.length) log.debug(`Agent ${this.id} was sent settings it does not know: ${unknown.join(', ')}`)

    // The name of a proxy this host holds, or nothing for a direct connection. Resolved when a
    // session opens rather than here: the file is read once at startup, and a name that is not in
    // it has to fail the connection loudly rather than be quietly forgotten at configuration time.
    this.proxy = values['connect.proxy']?.trim() || undefined

    this.chatSender = compile(values['chat.sender'], `Agent ${this.id}'s chat sender pattern`)
    this.chatWhisper = compile(values['chat.whisper'], `Agent ${this.id}'s whisper pattern`)
    this.chatWhisperSent = compile(values['chat.whisperSent'], `Agent ${this.id}'s sent-whisper pattern`)
    this.whisperCommand = values['chat.whisperCommand']?.trim() || undefined

    log.info(
      `Agent ${this.id} reads chat senders with ${this.chatSender ?? `${VANILLA} (vanilla)`}` +
        `, whispers with ${this.chatWhisper ?? `${WHISPER} (vanilla)`}` +
        `, sent whispers with ${this.chatWhisperSent ?? `${WHISPER_SENT} (vanilla)`}`,
    )

    // Both of these are read when a session opens, so changing either mid-game is stored now and
    // applied on the next connect. Said plainly rather than silently: an operator who pins a version
    // while an agent is in game is owed an answer about why nothing happened.
    this.version = playable(values['mc.version'], `Agent ${this.id}'s Minecraft version`)
    this.knockback = switched(values['mc.knockback'], `Agent ${this.id}'s knockback correction`)
    this.takeKnockback = switched(values['mc.takeKnockback'], `Agent ${this.id}'s knockback`)

    // Read per pass by the modules themselves, so a toggle applies to an agent already in game.
    this.noFall = switched(values['util.noFall'], `Agent ${this.id}'s no-fall`) === true
    this.antiHunger = antiHungerFrom(values['util.antiHunger'])
    this.autoEat = modeFrom(values['util.autoEat'])
    this.autoTotem = modeFrom(values['util.autoTotem'])
    this.fleeDistance = distanceFrom(values['util.fleeDistance'])

    // Named rather than counted, because "3 modules" answers nothing an operator asked. The two that
    // tell the server something untrue are worth seeing in a log beside the two that do not.
    const running = [
      this.noFall ? 'no-fall' : undefined,
      this.antiHunger !== 'off' ? `anti-hunger (${this.antiHunger})` : undefined,
      this.autoEat !== 'off' ? `auto-eat (${this.autoEat})` : undefined,
      this.autoTotem !== 'off' ? `auto-totem (${this.autoTotem})` : undefined,
      this.fleeDistance ? `flee within ${this.fleeDistance}m` : undefined,
    ].filter((name) => name !== undefined)

    log.info(
      running.length
        ? `Agent ${this.id} runs ${running.join(', ')}`
        : `Agent ${this.id} runs no utility modules`,
    )

    this.trusted = trustedFrom(values['players.whitelist'])

    // Each entry with the tier it was given, because which of the two somebody holds is the whole
    // question when a command is refused - and a Map joined plainly reads as `integr,commands`.
    const who = [...this.trusted].map(([name, grant]) => `${name} (${grantLabel(grant)})`).join(', ')

    log.info(
      who
        ? `Agent ${this.id} takes chat commands from ${who}`
        : `Agent ${this.id} takes chat commands from nobody, because no player is trusted`,
    )

    // Knockback is read per packet, so it applies at once; the version is settled before a session
    // opens and cannot. Said separately, because "from its next connect" applied to both was how a
    // setting that had in fact taken effect looked like one that had not.
    log.info(
      `Agent ${this.id} ${this.takeKnockback === false ? 'ignores knockback' : 'takes knockback'}` +
        `, correcting it ${this.knockback === undefined ? 'when the version needs it' : this.knockback ? 'always' : 'never'}`,
    )

    log.info(
      `Agent ${this.id} speaks ${this.version ?? 'whatever the server asks for'}` +
        `${this.version && this.bot ? ', from its next connect' : ''}`,
    )
  }

  private say(message: string): void {
    if (!this.bot) {
      log.warn(`Agent ${this.id} cannot speak while out of game`)
      return
    }

    this.bot.chat(message)

    /*
     * A command is reported here; anything else waits for the server to say it back.
     *
     * The difference is whether a line is ever going to come back at all. `/tp` produces no chat, so
     * reporting it on the way out is the only chance to report it - and what an operator wants to
     * see is that it was sent. Ordinary chat does come back, dressed in whatever the server puts
     * around it, and that rendered line is worth more than the bare string that went out: it is the
     * agent's own words in the same form as everybody else's, prefix and colours and all.
     *
     * Nothing is remembered about what was said. Recognising the echo is the same question as
     * recognising anybody else's line - who sent it - and it is answered from the packet or from the
     * pattern, never from the words. See `heard`.
     */
    if (message.startsWith('/')) {
      this.hooks.event({
        type: 'chat',
        agentId: this.id,
        scope: ChatScope.Outbound,
        from: this.identity?.username ?? SERVER,
        text: message,
      })
    }
  }

  /**
   * One line of chat, from whichever packet carried it.
   *
   * `sender` is the speaker's uuid, and the protocol only supplies it on **real player chat**. A
   * server that reformats its chat - which is most of them - cancels that and sends a system message
   * instead, so the uuid is gone because the formatter discarded it rather than because anything
   * here lost it. That is the whole shape of this: believe the packet when it says something, and
   * fall back to reading the line when it does not.
   */
  private heard(message: string, position: string, json: unknown, sender?: string): void {
    // The action bar. Not chat at all, and never anybody speaking - so it is dropped before it can
    // be mistaken for our own words coming back.
    if (position === 'game_info') return

    // Only `playerChat` carries a signed speaker. Everything else is the server talking, whether it
    // is genuinely the server or a plugin speaking on a player's behalf.
    const signed = position === 'chat' ? sender : undefined
    // Kept by mineflayer from the player list, and not in its published types.
    const roster = this.bot as unknown as { uuidToUsername?: Record<string, string> } | undefined

    /*
     * Who the line says said it: the packet's uuid first, the pattern second, nobody third.
     *
     * Never inferred from what the words are. Reading our own text back out of a line looked like it
     * worked and was guesswork: a message of "gg" is inside half the things anybody says, so the
     * room's chat could be claimed as this agent's - and the shorter the message the likelier that
     * became.
     */
    const read = senderOf(message, this.chatSender)
    const speaker = signed ? roster?.uuidToUsername?.[signed] : read === SERVER ? undefined : read

    /*
     * Our own words coming back, decided the same way anybody else's are.
     *
     * The uuid settles it where the protocol supplies one. Where it does not - a server that
     * reformats its chat - the name read out of the line settles it instead, which needs a pattern
     * that matches that server. Without one this agent's messages are simply lines the host cannot
     * attribute, exactly like everybody else's, and that is the honest answer rather than a guess.
     */
    /*
     * A whisper this agent sent, coming back.
     *
     * Read from its own pattern because a server writes the two directions differently, and because
     * the name in the line is the *recipient* — the speaker is this agent and is not written there
     * at all. Without it an operator's own private message returns unattributable and is filed as
     * the server talking, which is the one line in the feed they know for certain was theirs.
     */
    const sent = this.chatWhisperSent ? senderOf(message, this.chatWhisperSent) !== SERVER : false

    const ours =
      sent || (signed ? signed === this.identity?.uuid : speaker !== undefined && speaker === this.identity?.username)

    /*
     * A whisper: chat addressed to this agent rather than to the room.
     *
     * Read from the line for the same reason the speaker is - a server that reformats chat sends one
     * rendered string, and which of them is a whisper is not marked anywhere else. Checked against
     * the raw line rather than against `speaker`, because the pattern has to see the whole shape of
     * it: "Notch whispers to you:" is what says this is private, and the name alone does not.
     */
    const whispered = this.chatWhisper ? senderOf(message, this.chatWhisper) : SERVER
    const direct = !ours && whispered !== SERVER

    /*
     * What the speaker **typed**, with the server's decoration taken off the front.
     *
     * The same pattern that named them says where the server's decoration ends, so ` [★57]
     * [MEMBER] integr [ʙʟᴏᴏᴍ] » !osm id` becomes `!osm id`. Anchoring on the raw line instead
     * looked stricter and was simply broken - on any server that renders a rank the prefix is never
     * at position zero, so no command ever fired.
     *
     * Read once and used twice. The backend compares what people said to find somebody repeating
     * themselves, and it has to compare the same thing this does: a rank prefix is constant per
     * player and most of a short line, so two unrelated messages look alike until it is off.
     *
     * Commands run from it here, before the listener guard, because that guard is about *reporting*
     * and this is not. The election exists so twenty agents do not send the backend one line twenty
     * times. Every agent still hears the room, and `!osm id` asked of everybody has to be answered
     * by everybody - an agent that stayed silent because somebody else was elected to forward chat
     * would look broken to whoever typed it.
     */
    const format = direct ? (this.chatWhisper ?? WHISPER) : (this.chatSender ?? VANILLA)
    const typed = ours ? undefined : spokenIn(message, format)

    if (typed !== undefined) this.commanded(typed, direct ? whispered : speaker, direct)

    /*
     * The listener role covers **the room**, and only the room.
     *
     * Our own words and anything said *to* this agent are owed to the operator whether or not this
     * agent was elected to forward everyone else's chat - the election exists so twenty agents do
     * not report one line twenty times, which is not a problem a whisper has.
     */
    if (!ours && !direct && !this.listening) return

    // The styled form of the same line: colours, ranks, and whatever the server dressed it in. Left
    // out when there is nothing to add, in which case the plain text stands alone as it always did.
    const components = componentsOf(json, this.language)

    this.hooks.event({
      type: 'chat',
      agentId: this.id,
      // Everything left over is global, which is the most this host can honestly claim about a line
      // it can only tell was said somewhere it could hear.
      scope: ours ? ChatScope.Outbound : direct ? ChatScope.Direct : ChatScope.Global,
      /*
       * Never this agent's label. Every agent on a server sees the same room, so naming the observer
       * turns the server's small talk into that agent's conversation, and made every line in the
       * feed look like the bot talking to itself.
       */
      // A whisper names its sender in the line rather than in the usual place, so that pattern is
      // what answers for one.
      from: ours ? (this.identity?.username ?? SERVER) : direct ? whispered : (speaker ?? SERVER),
      text: message,
      ...(components ? { components } : {}),
      ...(typed ? { typed } : {}),
    })
  }

  /** Stops this agent and hands its account back.
   *
   * Told before it is forgotten, so it leaves the game rather than having its session torn down
   * around it. */
  /**
   * Acts on a line of chat, if it is a command and the person who said it may give one.
   *
   * **The only place in this host that acts on something a stranger typed.** Everything else arrives
   * over the authenticated socket from the backend, so the guards here are the whole of the trust
   * boundary and are checked in the order that fails cheapest:
   *
   * 1. It has to parse as a command. Nearly every line stops here.
   * 2. It has to be addressed to this agent, by account or to everybody.
   * 3. It has to come from somebody the operator named.
   *
   * **Only as trustworthy as the name is.** Where the protocol signs player chat, `speaker` came
   * from a uuid and cannot be faked. Where it does not - a server that reformats its chat, which is
   * exactly the kind that needs `chat.sender` - the name was read out of the rendered line, so a
   * loose pattern is a way in. A pattern anchored at the start of the line, as the documented ones
   * are, cannot be talked past by anything typed into a message.
   *
   * Silence is the answer to a command from somebody untrusted. Saying "you may not do that" tells
   * a stranger that this account is a bot, that Osmium is behind it, and that there is a list to get
   * onto - and it hands anybody a way to make the fleet talk.
   */
  private commanded(message: string, speaker: string | undefined, direct: boolean): void {
    const command = commandIn(message)
    if (!command) return

    /*
     * A private message is already addressed: it reached exactly one agent because somebody sent it
     * to exactly one account. So `!osm run …` on its own is enough there, and naming the account
     * would be saying twice what the whisper already said.
     *
     * Naming a *different* account is still honoured — it is refused here, and answered by nothing,
     * since the agent it names never heard the whisper. Acting anyway would be this agent answering
     * to a name that is not its own.
     */
    if (!addressedTo(command, this.identity?.username)) return

    const held = speaker ? this.trusted.get(speaker.toLowerCase()) : undefined

    if (!allows(held, command.name)) {
      log.debug(
        `Agent ${this.id} ignored ${command.name} from ${speaker ?? 'somebody it could not name'}` +
          ` (trusted for ${grantLabel(held)})`,
      )
      return
    }

    // Silently, like every other refusal here. Somebody trusted enough to send this is somebody who
    // will see the agent standing on a half-built wall and work out why; answering would announce
    // to the room that the account is a bot with work queued.
    if (disruptsBuilding(command.name) && this.busy(`${command.name} from ${speaker ?? 'chat'}`)) return

    log.info(`Agent ${this.id} was told to ${command.name} by ${speaker}`)

    /*
     * Where an answer goes: back the way the question came.
     *
     * A question asked privately is answered privately — the room did not ask and does not need the
     * agent reciting its health at it. Asked in chat, the answer belongs in chat, where whoever
     * asked is looking.
     *
     * `say` and `run` ignore this on purpose. They are not answers: one is speech into the room and
     * the other is an action in the world, and doing either privately would do a different thing
     * than the one that was asked for.
     */
    const back = direct ? speaker : undefined

    switch (command.name) {
      case 'id':
        this.answer(`Agent ${this.id} running osmium v${VERSION}`, back)
        return

      case 'say': {
        // Refused rather than trimmed into something else: see `sayable`. A server command and a
        // command to the fleet are both things this agent must not be talked into.
        const words = sayable(command.args)
        if (!words) {
          log.debug(`Agent ${this.id} would not say what ${speaker} asked it to`)
          return
        }

        this.say(words)
        return
      }

      case 'ping':
        // From our own row of the player list, which is the only place a server states our latency.
        this.answer(`Agent ${this.id} at ${Math.max(0, Math.round(this.bot?.player?.ping ?? 0))}ms`, back)
        return

      /*
       * Out of twenty, the way the game shows them, rather than as a bare number.
       *
       * `18` alone is only a reading to somebody who already knows the scale, and half the point of
       * asking from in game is that the person asking is looking at their own bar.
       */
      case 'health':
        this.answer(`Agent ${this.id} at ${halves(this.bot?.health)} health`, back)
        return

      case 'food':
        this.answer(`Agent ${this.id} at ${halves(this.bot?.food)} food`, back)
        return

      /* How long this session has been going, which is not how long the process has. An agent that
       * dropped and came back an hour ago has been in game for an hour, and that is the number
       * somebody in the room is asking about. */
      case 'uptime': {
        const since = this.session?.joinedAt
        this.answer(since ? `Agent ${this.id} in game for ${lasted(since)}` : `Agent ${this.id} has just arrived`, back)
        return
      }

      case 'help':
        this.answer(helpLine(held), back)
        return

      /*
       * The three toys. They answer where they were asked, like every other reading does, and they
       * take their randomness from here so the functions themselves stay testable.
       *
       * The question is deliberately not repeated back - see `EIGHT_BALL`.
       */
      case '8ball':
        this.answer(`Agent ${this.id} says ${eightBall(Math.random())}`, back)
        return

      case 'cf':
        this.answer(`Agent ${this.id} flipped ${coinFlip(Math.random())}`, back)
        return

      case 'roll': {
        const { sides, face } = rolled(command.args, Math.random())
        this.answer(`Agent ${this.id} rolled ${face} of ${sides}`, back)
        return
      }

      case 'disconnect':
        log.info(`Agent ${this.id} was told to leave by ${speaker}`)
        this.activity(ActivityScope.System, Severity.Warning, `${speaker} disconnected this agent from chat`)
        this.handle({ type: 'disconnect' })
        return

      case 'reconnect': {
        const address = this.session?.address
        if (!address) return

        log.info(`Agent ${this.id} was told to reconnect by ${speaker}`)
        this.activity(ActivityScope.System, Severity.Warning, `${speaker} reconnected this agent from chat`)

        // Remembered rather than queued behind the disconnect: leaving is fire and forget and the
        // session ends some time later, so a `connect` queued now would arrive while this one is
        // still in game and be refused as already connected. `ended` starts it once there is
        // nothing to be in the way.
        this.returning = address
        this.handle({ type: 'disconnect' })
        return
      }

      case 'run': {
        const typed = runnable(command.args)
        if (!typed) return

        // Logged at info, unlike the others. This is the one command that acts under the agent's own
        // Minecraft permissions, so what was run and who asked belongs in the record whether or not
        // anybody is reading debug.
        log.info(`Agent ${this.id} is running ${typed} for ${speaker}`)
        this.activity(ActivityScope.System, Severity.Warning, `${speaker} ran ${typed} through this agent`)
        this.say(typed)
        return
      }
    }
  }

  /**
   * Answers a command, privately when it was asked privately.
   *
   * **Falls back to the room rather than staying silent.** Whispering needs the server's own command
   * for it, which is not the same everywhere — `chat.whisperCommand` says which, and a host with the
   * wrong one would otherwise answer into a void. An answer in the wrong channel is a small
   * indiscretion; an answer nobody ever sees is a feature that looks broken.
   */
  private answer(text: string, to: string | undefined): void {
    if (!to) {
      this.say(text)
      return
    }

    const whispered = whisperWith(this.whisperCommand ?? WHISPER_COMMAND, to, text)

    if (!whispered) {
      log.warn(`Agent ${this.id} could not whisper ${to}, so it answered in chat instead`)
      this.say(text)
      return
    }

    this.say(whispered)
  }

  private async remove(): Promise<void> {
    this.done = true
    // Not just the stream: the agent is gone, so there is nothing left to come back for.
    this.watched = false
    this.unwatch()

    if (this.bot) {
      this.leaving = true
      this.bot.quit()
    }

    clearInterval(this.vitals)
    this.vitals = undefined

    // Its credential goes back to the pool. The agent being deleted says nothing about whether the
    // operator still wants to play that account.
    await this.store.release(this.id)

    log.info(`Agent ${this.id} was deleted`)
    this.hooks.finished()
  }

  /**
   * The four readings, taken together or not at all.
   *
   * Nothing is sent while any of them is missing rather than a partial tick: the backend drops one
   * of those whole, and a zero it filled in for us would render as an agent in trouble that is fine.
   */
  private sample(): void {
    const bot = this.bot
    if (!bot?.entity) return

    const position = point(bot.entity.position)

    if (bot.health === undefined || bot.food === undefined) return

    const vitals: Vitals = {
      health: Math.max(0, Math.round(bot.health)),
      food: Math.max(0, Math.round(bot.food)),
      // Our own row of the player list is where the server states our latency, and there is nowhere
      // else it is exposed. Zero rather than skipping the tick: a server that never sends one would
      // otherwise cost the operator every other reading as well.
      ping: Math.max(0, Math.round(bot.player?.ping ?? 0)),
      position,
    }

    // Alongside the vitals rather than inside them: the backend treats the four readings as one
    // all-or-nothing value and defaults a missing dimension to the overworld, so an agent in the end
    // read as being in the overworld on every tick until this was sent.
    //
    // Omitted rather than sent as undefined when the server has not said. Absent is what the wire
    // means by "nothing to report", and the backend's own default is then the honest answer.
    const dimension = worldOf(bot, this.level) || undefined

    this.report({ vitals, nearby: nearby(bot, position), ...(dimension ? { dimension } : {}) })
  }

  /** Says whether this agent is standing in a world it can actually see.
   *
   * A warning rather than an activity entry: it is a fault in this host's picture of the server, not
   * something the operator did or can act on from the interface. */
  private grounded(): void {
    const bot = this.bot
    if (!bot?.entity) return

    if (bot.blockAt(bot.entity.position)) {
      log.debug(`Agent ${this.id} has the world loaded around it`)

      // What the physics engine thinks it is standing in. A block palette that does not line up -
      // which is what speaking one version to a server translating from another risks - reads as an
      // agent encased in stone, and an encased agent has every movement cancelled by collision while
      // everything else about it looks perfectly healthy.
      const at = bot.entity.position
      const name = (dx: number, dy: number, dz: number) => bot.blockAt(at.offset(dx, dy, dz))?.name ?? 'unknown'

      log.debug(
        `Agent ${this.id} stands in ${name(0, 0, 0)}, head in ${name(0, 1, 0)}, on ${name(0, -1, 0)}, ` +
          `sides ${name(1, 0, 0)}/${name(-1, 0, 0)}/${name(0, 0, 1)}/${name(0, 0, -1)}`,
      )
      return
    }

    log.warn(
      `Agent ${this.id} is in game but its chunks did not load, so it will not move, fall or take knockback. Run with OSMIUM_LOG=debug to see what the server sent.`,
    )
  }

  /**
   * Takes the backend's word for whether anyone is watching.
   *
   * The subscription is remembered even when it cannot be served - an agent between sessions has no
   * world to stream, and being told about a watcher then is the only way to have one waiting when
   * it spawns back in.
   */
  private watch(enabled: boolean): void {
    if (this.watched === enabled) return
    this.watched = enabled

    if (!enabled) {
      this.unwatch()
      return
    }

    // Only once the world is there. Before `spawn` there is nothing to send, and `bot.entity` -
    // which the viewer centres on - does not exist yet.
    if (this.joined && this.bot?.entity) this.begin_watching()
  }

  private begin_watching(): void {
    const bot = this.bot
    if (!bot?.entity || this.watcher) return

    this.watcher = new AgentViewer(this.id, bot, (frame) => this.hooks.viewer(frame))
    this.watcher.start()
  }

  private unwatch(): void {
    this.watcher?.stop()
    this.watcher = undefined
  }

  /**
   * Starts the utility modules for this session.
   *
   * Per session because every one of them holds a listener or a timer against this bot, and a
   * session that ended takes them with it. What they are told to do is read live, so an operator
   * toggling one while an agent stands in the game does not have to reconnect it.
   */
  private begin_utilities(): void {
    const bot = this.bot
    if (!bot?.entity) return

    this.unutilities()
    this.utilities = new AgentUtilities(
      this.id,
      bot,
      () => ({
        noFall: this.noFall,
        antiHunger: this.antiHunger,
        autoEat: this.autoEat,
        autoTotem: this.autoTotem,
        fleeDistance: this.fleeDistance,
      }),
      {
        // The same list that says who may command it. Somebody the operator vouched for is somebody
        // the agent will stand next to, and keeping one list means there is one thing to get right.
        trusted: (name) => this.trusted.has(name.toLowerCase()),
        flee: (who, distance) => this.retreat(who, distance),
      },
    )
    this.utilities.start()
  }

  /**
   * Leaves, and asks not to be sent back.
   *
   * **The disconnect alone would not hold.** `connect.rejoin` is the backend's, and the rejoin sweep
   * reads the agent going offline as a drop and dials it straight back into the server it just
   * fled - so the two would take turns for as long as the stranger stood there. `stand_down` is the
   * host saying this was a decision rather than a failure, and the backend answers by wanting the
   * agent where it is.
   *
   * Raised as an incident, not as chat. An agent that left on its own at three in the morning is
   * exactly the thing an operator needs on the dashboard rather than scrolled past in a feed.
   */
  private retreat(who: string, distance: number): void {
    const away = Math.round(distance)

    log.warn(`Agent ${this.id} is leaving: ${who} came within ${away}m`)
    this.activity(
      ActivityScope.System,
      Severity.Error,
      `Left the server: ${who} came within ${away} blocks and is not on the trust list`,
    )

    this.hooks.event({
      type: 'stand_down',
      agentId: this.id,
      reason: `${who} came within ${away} blocks`,
    })

    this.handle({ type: 'disconnect' })
  }

  private unutilities(): void {
    this.utilities?.stop()
    this.utilities = undefined
  }

  /** Starts mapping this session, replacing any mapper left over from the last one. */
  private begin_mapping(): void {
    const bot = this.bot
    if (!bot?.entity) return

    this.unmap()
    this.mapper = new AgentMap(
      this.id,
      bot,
      (tile) => this.hooks.event({ type: 'map_tile', agentId: this.id, tile }),
      () => this.level,
    )
    this.mapper.start()
  }

  private unmap(): void {
    this.mapper?.stop()
    this.mapper = undefined
  }

  /** Starts reporting this session's inventory, replacing any reporter left from the last one. */
  /**
   * Says again everything the backend keeps only in memory.
   *
   * Called when a socket comes up, which may be a backend that has just restarted and holds none
   * of it. Only the inventory today: state is restated by the handshake itself, vitals go out on
   * their own timer within seconds, and map tiles are in Postgres.
   *
   * Safe to call at any time. It asks the reporter to send on its next pass rather than sending
   * anything here, so an agent between sessions does nothing at all.
   */
  restate(): void {
    this.carrying?.refresh()
  }

  private begin_carrying(): void {
    const bot = this.bot
    if (!bot?.entity) return

    this.uncarry()
    this.carrying = new AgentInventory(this.id, bot, (inventory) =>
      this.hooks.event({ type: 'inventory', agentId: this.id, inventory }),
    )
    this.carrying.start()
  }

  private uncarry(): void {
    this.carrying?.stop()
    this.carrying = undefined
  }

  /**
   * Moves what is in one square onto another, as two clicks would.
   *
   * Both ends are checked before anything is clicked. `moveSlotItem` on the crafting output is not
   * a move the server can accept, and one on a slot outside the window is a click on nothing - so
   * an out-of-range request is refused here rather than sent and quietly lost.
   *
   * Nothing is reported back. The next inventory event says where the item ended up, which is the
   * same event that would have said so had the agent moved it itself, and it is the answer whether
   * or not the server allowed the move.
   */
  /**
   * Puts a hotbar square in the agent's hand.
   *
   * Converted to the index mineflayer wants here, at the one place that knows both numberings. The
   * wire names the square the way every other inventory command does; the game keeps the hand as an
   * index into the hotbar, and translating at the edge is what keeps that from leaking either way.
   *
   * Not awaited and nothing is reported: the change is a single packet, and the inventory event
   * that follows carries the new `held` the same way it carries everything else.
   */
  private hold(slot: number): void {
    const bot = this.bot
    if (!bot || !this.joined) return log.warn(`Agent ${this.id} is not in game, ignoring a hand change`)
    if (!holdable(slot)) return log.warn(`Agent ${this.id} cannot hold slot ${slot}`)

    bot.setQuickBarSlot(slot - HOTBAR_FIRST)
    this.carrying?.refresh()
  }

  private async shift(from: number, to: number): Promise<void> {
    const bot = this.bot
    if (!bot || !this.joined) return log.warn(`Agent ${this.id} is not in game, ignoring a slot move`)
    if (!movable(from) || !movable(to)) return log.warn(`Agent ${this.id} cannot move ${from} to ${to}`)
    if (from === to) return

    try {
      await bot.moveSlotItem(from, to)
    } catch (failure) {
      // A slot the server refused, or a window that closed mid-move. The operator sees the item
      // stay where it was, which is what happened.
      log.debug(`Agent ${this.id} could not move slot ${from} to ${to}: ${String(failure)}`)
    }
    this.carrying?.refresh()
  }

  /**
   * Throws what is in a square on the ground.
   *
   * **The game's own drop click, not `bot.toss`.** Mode 4 acts on the square named in the packet
   * and picks nothing up: button 1 throws the stack, button 0 throws one, which is Q and Ctrl-Q.
   *
   * `toss` looked like the obvious call and is the wrong shape twice over. It searches by *item
   * type* across the whole inventory range, so dropping one from a hotbar square could take it off
   * a different stack of the same thing - and it works by picking the stack up onto the cursor and
   * putting the remainder back through `putSelectedItemRange`, which returns it to the first slot
   * it will fit in rather than to the one it came from. Dropping one item from the hotbar therefore
   * moved the other sixty-three into the backpack.
   *
   * There is no "drop N" click in the protocol - a player presses Q N times - so a partial drop is
   * that many clicks, bounded by what is actually in the square.
   */
  private async drop(slot: number, count: number | undefined): Promise<void> {
    const bot = this.bot
    if (!bot || !this.joined) return log.warn(`Agent ${this.id} is not in game, ignoring a drop`)
    if (!movable(slot)) return log.warn(`Agent ${this.id} cannot drop slot ${slot}`)

    const item = bot.inventory.slots[slot]
    if (!item) return

    try {
      if (count === undefined || count >= item.count) {
        await bot.clickWindow(slot, DROP_STACK, DROP_CLICK)
      } else {
        const throwing = Math.max(1, Math.floor(count))
        for (let thrown = 0; thrown < throwing; thrown++) await bot.clickWindow(slot, DROP_ONE, DROP_CLICK)
      }
    } catch (failure) {
      log.debug(`Agent ${this.id} could not drop slot ${slot}: ${String(failure)}`)
    }
    this.carrying?.refresh()
  }

  private report(status: {
    state?: LoginState
    vitals?: Vitals
    nearby?: Player[]
    dimension?: string
  }): void {
    this.hooks.event({ type: 'agent_status', agentId: this.id, ...status })
  }

  private activity(scope: ActivityScope, severity: Severity, text: string): void {
    this.hooks.event({ type: 'activity', agentId: this.id, scope, severity, text })
  }

  /**
   * What a server's component actually says, as one line of plain text.
   *
   * Resolved against this session's language table, so a kick sent as `multiplayer.disconnect.kicked`
   * and a death sent as `death.attack.mob` become sentences rather than keys. Empty when there is
   * nothing readable in there - the caller then says less instead of printing `[object Object]`, or
   * a wall of JSON, which is what this replaced.
   */
  private readable(message: unknown): string {
    const resolved = componentsOf(message, this.language)
    const flat = resolved ? flatten(resolved).trim() : ''

    if (flat) return flat

    return typeof message === 'string' ? message.trim() : ''
  }

  /**
   * Signs in to Microsoft, and keeps what that yields.
   *
   * **The code reaches the operator as an activity entry**, which is the only channel in this
   * protocol they actually read. A `reason` on the setup result is log-only, and a host running
   * headless in a container has nobody watching its terminal - so printing it there would be telling
   * it to a room with no one in it.
   *
   * Nothing times this out on either side. The operator may be signing in on a phone, in another
   * room, tomorrow; they can give up from the interface, which returns the agent to UNLINKED and
   * sends us nothing.
   */
  private async link(): Promise<Entry | undefined> {
    const show = (code: LinkCode) => {
      this.activity(
        ActivityScope.Lifecycle,
        Severity.Info,
        `Sign in at ${code.url} and enter the code ${code.code}. It expires in ${Math.round(code.expiresIn / 60)} minutes.`,
      )
    }

    let acquired: Awaited<ReturnType<typeof signIn>>
    try {
      acquired = await signIn(this.cacheDirectory, show)
    } catch (err) {
      log.warn(`Agent ${this.id} was never signed in: ${reason(err)}`)
      this.activity(
        ActivityScope.Lifecycle,
        Severity.Warning,
        `The Microsoft sign-in did not complete: ${reason(err)}`,
      )
      this.hooks.result({ ok: false, reason: 'The Microsoft sign-in was not completed' })
      return undefined
    }

    // Kept before it is used. The operator has done the one part of this nobody can repeat for
    // them, so a credential that works but was never written down is the worst outcome available:
    // it looks like success until the next restart.
    try {
      return await this.store.adopt(
        { kind: LoginKind.RefreshToken, cache: acquired.cache, username: acquired.username, uuid: acquired.uuid },
        this.id,
      )
    } catch (err) {
      log.warn(`Agent ${this.id} signed in but the account could not be saved: ${reason(err)}`)
      this.hooks.result({ ok: false, reason: 'Signed in, but the account could not be saved on this host' })
      return undefined
    }
  }
}

/** How this agent proves who it is to the server.
 *
 * A Microsoft account signs in through node-minecraft-protocol, out of the same cache this host
 * wrote when it acquired the account - so nothing is asked of the operator a second time. */
function credentials(entry: Entry, identity: Identity, directory: string): Partial<BotOptions> {
  switch (entry.kind) {
    case LoginKind.RefreshToken:
      return { username: entry.cache!, auth: 'microsoft', profilesFolder: directory }

    case LoginKind.MojangToken:
      return { username: identity.username, auth: session(entry.token!, identity) }

    case LoginKind.NoToken:
      return { username: identity.username, auth: 'offline' }
  }
}

/**
 * A Minecraft session token, handed straight to the protocol.
 *
 * node-minecraft-protocol takes a function here for exactly this: a credential nothing in its own
 * authentication ever produces. Chat is left unsigned - the signing keys come from the sign-in this
 * kind of credential skips - so a server running `enforce-secure-profile` will refuse to relay
 * anything this agent says.
 */
function session(token: string, identity: Identity): NonNullable<BotOptions['auth']> {
  const undashed = identity.uuid.replaceAll('-', '')

  return ((client: any, options: any) => {
    const profile = { id: undashed, name: identity.username }

    client.session = { accessToken: token, selectedProfile: profile, availableProfiles: [profile] }
    client.username = identity.username
    options.accessToken = token
    // Without this the protocol assumes an offline server and never joins the session server, so an
    // online one refuses the agent at encryption.
    options.haveCredentials = true

    client.emit('session', client.session)
    options.connect(client)
  }) as unknown as NonNullable<BotOptions['auth']>
}

/** Who else is standing around, nearest first.
 *
 * **Players the server currently lists that also have an entity loaded.** Either half alone is the
 * wrong answer: the tab list is everyone on the server, including whoever is in another dimension,
 * and an entity alone counts hub NPCs - they are spawned as player entities and put in the tab list
 * just long enough for a client to learn their skin, then taken back out.
 *
 * Our own agents are included on purpose. A host sees only its own, and a server's fleet can span
 * several hosts, so no host can tell one of ours from a stranger - Osmium decides that, which is why
 * the contract forbids sending `isAgent`. */
function nearby(bot: Bot, from: Vec3): Player[] {
  const found: Player[] = []
  const health = healthKey(bot)

  for (const [name, player] of Object.entries(bot.players)) {
    // Ourselves. We are a player entity like any other and would otherwise be reported as standing
    // zero blocks from ourselves.
    if (name === bot.username) continue
    // **This is the range test.** `bot.players` is the tab list, which is everyone on the server
    // including whoever is in another world entirely; `entity` is set only for those the client is
    // actually tracking, which is exactly what is inside the render distance the server granted us.
    // Measuring a radius on top of it only ever hid people the agent could genuinely see.
    if (!player?.entity || !isAUsername(name)) continue

    const position = point(player.entity.position)

    // Everything the server actually told us about them, and nothing inferred.
    found.push({
      name,
      distance: separation(from, position),
      position,
      ...(player.uuid ? { uuid: player.uuid } : {}),
      ...(typeof player.ping === 'number' ? { ping: player.ping } : {}),
      ...(typeof player.gamemode === 'number' ? { gamemode: player.gamemode } : {}),
      ...healthOf(player.entity, health),
    })
  }

  return found.sort((one, other) => one.distance - other.distance).slice(0, NEARBY_LIMIT)
}

/**
 * Where this version keeps a living entity's health in its metadata.
 *
 * **Looked up by name, never written down.** Health is index 9 on every version this has been
 * checked against, and hardcoding that is exactly the mistake that produces a number which is wrong
 * without ever looking wrong. `minecraft-data` names the keys per version and mineflayer resolves
 * its own metadata the same way.
 *
 * Read once per report rather than per player: it is a scan of twenty-odd entries, and a busy
 * server is two hundred players.
 */
export function healthKey(bot: Bot): number | undefined {
  const player = bot.registry.entitiesByName['player'] as { metadataKeys?: Record<string, string> } | undefined
  for (const [at, named] of Object.entries(player?.metadataKeys ?? {})) {
    if (named === 'health') return Number(at)
  }
  return undefined
}

/**
 * What the server has said about somebody else's health, if anything.
 *
 * **Every client is sent this**, contrary to what this file used to claim: health is a synced field
 * on every living entity, which is how a health-tag mod works without a server plugin. What is
 * genuinely true is that mineflayer does not lift it out for entities other than the bot, so it is
 * read from the metadata array here.
 *
 * Absent rather than guessed, on the same terms as ping and gamemode. A server may strip it, and a
 * player who has just come into view has none until their first metadata packet arrives.
 */
export function healthOf(entity: { metadata?: unknown }, at: number | undefined): { health?: number } {
  if (at === undefined) return {}

  const value = (entity.metadata as unknown[] | undefined)?.[at]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return {}

  // Half a heart is the smallest state the game has, so one decimal is all there is to keep.
  return { health: Math.round(value * 10) / 10 }
}

/** Whether a name could belong to a person rather than to scenery.
 *
 * Mojang allows only letters, digits and underscores, so `»store«` is a decorated NPC rather than
 * somebody standing there. Deliberately not checking length: a cracked server may allow names Mojang
 * would not, and being wrong about a real player is worse than listing one shop sign. */
function isAUsername(name: string): boolean {
  return name.length > 0 && /^[A-Za-z0-9_]+$/.test(name)
}

function point(position: { x: number; y: number; z: number }): Vec3 {
  return { x: position.x, y: position.y, z: position.z }
}

function separation(from: Vec3, to: Vec3): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
}

/**
 * Decides what version to speak to a server, before opening a session on it.
 *
 * **Not mineflayer's own auto-detection.** That pings inside `createBot` and cannot survive either
 * answer this fleet actually meets. A server behind bot protection refuses the ping outright, and
 * node-minecraft-protocol then emits an error and *nothing else, ever* - no socket was opened, so
 * none closes, and the agent sits in CONNECTING until the backend gives up on it. A ViaVersion
 * server answers with protocol `9999`, a deliberate "any client welcome" marker that names no
 * version; the library emits an error for that and then reads the empty list it just complained
 * about, throwing where nobody can catch it usefully.
 *
 * Both are ordinary servers that a fixed-version client joins without trouble. So the ping happens
 * here, where failing it is survivable, and the session is always opened on a version we chose.
 */
async function negotiate(endpoint: Endpoint, id: number, route: ProxyEntry | undefined): Promise<string> {
  const address = `${endpoint.host}:${endpoint.port}`

  let response: Awaited<ReturnType<typeof status>>
  try {
    response = await status(endpoint, route)
  } catch (err) {
    log.info(`Agent ${id}: ${address} would not answer a version check (${reason(err)}), assuming ${ASSUMED}`)
    return ASSUMED
  }

  const protocol = response?.version?.protocol

  // A list, newest first, so a protocol shared by several point releases resolves to the latest of
  // them. Cast because minecraft-data's own typings describe one version where it holds several.
  const table = minecraftData.postNettyVersionsByProtocolVersion.pc as unknown as Record<number, { minecraftVersion: string }[] | undefined>
  const known = typeof protocol === 'number' ? table[protocol]?.[0]?.minecraftVersion : undefined

  if (!known) {
    log.info(`Agent ${id}: ${address} advertises protocol ${protocol}, which names no version here, assuming ${ASSUMED}`)
    return ASSUMED
  }

  log.debug(`Agent ${id}: ${address} speaks ${known}`)
  return known
}

/** A status ping, bounded. `ping` waits on a socket that a filtered server may simply never answer,
 * and nothing else here would ever time that out. */
/**
 * Asks a server what it is, through the proxy the session will use.
 *
 * **Through the same route, deliberately.** This is a real connection to the server - it opens a
 * socket, sends a handshake and reads a reply - so a ping that went direct would put this machine's
 * address in front of the very server the proxy exists to keep it away from, seconds before the
 * agent joined from somewhere else entirely.
 */
function status(
  endpoint: Endpoint,
  route: ProxyEntry | undefined,
): Promise<{ version?: { protocol?: number } } | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), PING)

    const through = route ? { connect: routed(route, endpoint.host, endpoint.port).connect } : {}

    minecraftProtocol.ping({ host: endpoint.host, port: endpoint.port, ...through }, (err, result) => {
      clearTimeout(timer)

      if (err) reject(err)
      else resolve(result as { version?: { protocol?: number } })
    })
  })
}

/**
 * Undoes mineflayer's scaling of entity velocity, on the versions where it is wrong.
 *
 * **Upstream bug, worked around here.** `entity_velocity` used to carry three shorts holding
 * eight-thousandths of a block per tick, and mineflayer multiplies what it reads by `1/8000`
 * accordingly. From 1.21.9 the field became an `lpVec3`, a quantised vector that decodes to blocks
 * per tick already - so the scaling divides real knockback by eight thousand. A 0.7 shove becomes
 * 0.00009, which is under the physics engine's `negligeableVelocity` of 0.003 and is discarded on
 * the first tick.
 *
 * The symptom is an agent that cannot be pushed by anything: no knockback, no explosions, no boats.
 * Everything else about it looks perfectly healthy, because nothing else reads that packet.
 *
 * The correction re-reads the packet and writes what it actually said. Applied only where the packet
 * really is an `lpVec3`; on anything older mineflayer is right and this does nothing.
 *
 * **Attached on `login`, and that timing is the whole trick.** Two handlers now write the same
 * field, so the later registration wins - and mineflayer does not register its own until
 * `inject_allowed`, which it fires from a `setTimeout` after version negotiation, long after
 * `createBot` has returned. Registering alongside everything else therefore lost silently: the
 * correction ran, and mineflayer overwrote it microseconds later. `login` is emitted by a plugin, so
 * by the time it arrives every plugin is loaded and anything registered from it is genuinely last.
 *
 * [wanted] overrides the version check in both directions, for a server this is wrong about. A
 * proxy can present one version and forward another - which is the whole point of ViaVersion - and
 * the packet's shape is decided by whatever is actually on the wire, not by what the handshake
 * claimed. `bot.version` cannot see through that, so an operator who can watch the agent get hit is
 * a better authority on it than the flag is.
 *
 * Remove once mineflayer scales by version. See PrismarineJS/mineflayer.
 */
function unscaleVelocity(
  bot: Bot,
  id: number,
  wanted: () => { take: boolean | undefined; correct: boolean | undefined },
): void {
  bot.once('login', () => {
    /*
     * **Read per packet rather than captured at login.** Both of these are settings an operator
     * changes while watching the agent, and a handler that froze them meant turning knockback off
     * did nothing until the next reconnect - with the only clue in a debug line nobody was reading.
     *
     * One handler rather than one per mode, for the same reason: two of them writing the same field,
     * one zeroing and one restoring, is a race nobody should have to reason about.
     *
     * **Not being pushed is a different setting from correcting the arithmetic.** Knockback reaches
     * a client as a velocity to apply to itself, so an agent that drops the one meant for its own
     * entity is not moved by hits, explosions or anything else that shoves. Only our own entity:
     * everybody else's motion is what the world looks like, and freezing that would leave the agent
     * watching a room where nothing moves.
     */
    const absolute = absoluteVelocity(bot.version)

    log.debug(`Agent ${id} handles velocity for ${bot.version}, which is ${absolute ? '' : 'not '}absolute`)

    bot._client.on(
      'entity_velocity',
      (packet: { entityId: number; velocity?: { x: number; y: number; z: number } }) => {
        const { take, correct } = wanted()

        if (take === false && packet.entityId === bot.entity?.id) {
          bot.entity.velocity.set(0, 0, 0)
          return
        }

        // Upstream is right before 1.21.9, so on those versions there is nothing to undo.
        if (!(correct ?? absolute)) return

        const entity = bot.entities?.[packet.entityId]
        if (!entity?.velocity || !packet.velocity) return

        entity.velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z)
      },
    )
  })
}

/**
 * Reads a configured Minecraft version, or nothing when there is no usable one.
 *
 * Checked against what this build can actually speak rather than against what Mojang has released.
 * `minecraft-data` knows hundreds of versions and node-minecraft-protocol has protocol definitions
 * for a fraction of them, and the failure for the rest arrives inside `createBot` as a throw with no
 * session behind it - which is the shape that leaves an agent stuck in CONNECTING.
 *
 * A version this build does not know is refused rather than approximated. The nearest one it does
 * know speaks a different protocol, and a client speaking the wrong protocol confidently is worse
 * than one that asked the server: it joins, then desynchronises in ways nobody traces back to here.
 */
export function playable(source: string | undefined, why: string): string | undefined {
  const wanted = source?.trim()
  if (!wanted) return undefined

  if (!minecraftData.supportedVersions.pc.includes(wanted)) {
    log.warn(`${why} is ${wanted}, which this host cannot speak - asking the server instead`)
    return undefined
  }

  return wanted
}

/**
 * Reads a configured switch, or nothing when it is unset.
 *
 * **Three states, not two.** Unset is a real answer that neither `true` nor `false` can stand in
 * for: it means the host decides, and a caller that collapsed it to `false` would turn "work it out"
 * into "definitely not" for every agent nobody has touched.
 */
/**
 * Who may command an agent from in game, read from the one string a setting holds.
 *
 * Lower-cased, because Minecraft compares names that way and nobody typing a name into chat is
 * checking their capitals. Anything that could not be a Minecraft name is dropped rather than kept
 * as an entry that matches nobody - the interface validates on the way in, and this is the same
 * check applied again on the side that actually acts on it.
 *
 * An unset or unusable setting yields an empty set, which is the safe answer: no player is trusted,
 * so no chat command is obeyed.
 */
export function trustedFrom(source: string | undefined): Map<string, Grant> {
  const trusted = new Map<string, Grant>()

  for (const entry of (source ?? '').split(/[\s,]+/)) {
    // `name`, `name:tier` or `name:one+two`. A username cannot contain a colon, so the first split
    // is unambiguous; `+` joins the commands because the entries themselves are comma-separated.
    // A setting from a newer Osmium must not quietly grant more than it says, which is why an
    // unrecognised word becomes a list of one - and a command that cannot be named is refused.
    const [name, granted] = entry.split(':')
    if (!name || !USERNAME.test(name)) continue

    trusted.set(name.toLowerCase(), grantFrom(granted))
  }

  return trusted
}

export function switched(source: string | undefined, why: string): boolean | undefined {
  const wanted = source?.trim().toLowerCase()
  if (!wanted) return undefined
  if (wanted === 'true') return true
  if (wanted === 'false') return false

  log.warn(`${why} is '${source}', which is neither true nor false - deciding it here instead`)
  return undefined
}

/** The translation table for a version, or an empty one when there is none.
 *
 * Loaded per session rather than per line: it is several thousand entries, and every message on a
 * connection is translated against the same one. */
function languageOf(version: string): Record<string, string> {
  try {
    return minecraftData(version).language ?? {}
  } catch {
    return {}
  }
}

/** Whether this version sends entity velocity in blocks per tick rather than in eight-thousandths.
 *
 * **minecraft-data's own flag**, rather than a version comparison or a look at the protocol types.
 * The distinction is already named and maintained upstream - which is the odd part of this bug:
 * mineflayer never asks. It reads the flag in one place, to choose which fields to read from a
 * spawn packet, and scales by `1/8000` regardless of the answer. */
export function absoluteVelocity(version: string): boolean {
  try {
    return minecraftData(version).supportFeature('entityVelocityIsLpVec3') === true
  } catch {
    // An unknown version is not a reason to refuse to play. Leaving mineflayer's own handling alone
    // is the conservative answer: it is right on every version before 1.21.9.
    return false
  }
}

/**
 * Shuts a session down, however far it got.
 *
 * **Not just `bot.quit`.** Mineflayer injects most of itself once the connection is under way, so a
 * bot that died during version detection has no `quit` on it yet - and calling it threw, leaving the
 * socket it was meant to close still open. The protocol client underneath exists from the first
 * moment and is what actually holds the socket.
 */
function close(bot: Bot, id: number): void {
  try {
    if (typeof bot.quit === 'function') bot.quit()
    else bot._client?.end('osmium')
  } catch (err) {
    log.debug(`Agent ${id} could not be closed cleanly: ${reason(err)}`)
  }
}

/**
 * A connection failure, in words an operator can act on.
 *
 * The network ones are named because they are the ones an operator causes and can fix. `ENOTFOUND`
 * in particular is almost always a typo in the address, and "socketClosed" - which is all the
 * protocol says on its own - gives them nothing to look at.
 */
function explain(err: unknown, address: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `could not find ${address} - check the address`

    case 'ECONNREFUSED':
      return `${address} refused the connection`

    case 'ETIMEDOUT':
      return `${address} did not answer`

    default:
      return reason(err)
  }
}

/** A kick reason, which arrives as a chat component and is only ever shown to a person. */
/** Everything a component tree says, with the styling dropped.
 *
 * Activity is a sentence in a feed rather than a rendered chat line, so the tree is flattened to
 * what it reads as. The tree it is given has already been resolved by `componentsOf`, so a
 * translation key like `death.attack.mob` has become "Mason_04 was slain by Zombie" before it
 * arrives here. */
export function flatten(node: Component): string {
  return node.text + (node.extra ?? []).map(flatten).join('')
}

/** Where an agent is, as a sentence: `128, 71, -344 in the overworld`.
 *
 * Undefined when the entity is not there yet, which is a real state - `login` arrives before the
 * world does. A caller says less rather than saying "at undefined". */
export function placeOf(bot: Bot, level?: string): string | undefined {
  const at = bot.entity?.position
  if (!at) return undefined

  const where = `${Math.round(at.x)}, ${Math.round(at.y)}, ${Math.round(at.z)}`
  const world = worldOf(bot, level)

  return world ? `${where} in ${named(world)}` : where
}

/** The three the game ships, which are the ones a sentence puts "the" in front of. */
const VANILLA_WORLDS = new Set(['overworld', 'the_nether', 'the_end', 'nether', 'end'])

/**
 * A world's name as it goes into a sentence.
 *
 * **The level name, not the dimension type**, and the same one the agent reports as its world -
 * so the line in the activity feed and the reading on the agent's own page agree about where it is.
 * They did not: this said "in the overworld" while the page said "Pvp Arena", because a server with
 * custom worlds runs nearly all of them as type `overworld` and the type is then true and useless.
 *
 * "the" only for the three the game ships. "in the overworld" is right and "in the pvp arena" is
 * not; a server's own world is a name rather than a place everybody knows. `the_end` drops its own
 * "the" first, or it reads as "in the the end".
 */
function named(world: string): string {
  const spoken = world.replaceAll('_', ' ').replace(/^the /, '')

  return VANILLA_WORLDS.has(world) ? `the ${spoken}` : spoken
}

/**
 * A health or food reading, on the scale the game draws it on: `18/20`.
 *
 * Rounded to a whole point, because that is what a bar shows. Undefined until the server has sent
 * one - a session that has just opened has no reading rather than a reading of zero, and answering
 * `0/20` would report a dying agent that is perfectly well.
 */
function halves(value: number | undefined): string {
  return value === undefined ? 'an unknown' : `${Math.max(0, Math.round(value))}/20`
}

/**
 * The name the server gives the world in a `login` or `respawn` packet.
 *
 * **Two places, because it moved.** Up to 1.20.4 it is `worldName` on the packet itself; from
 * 1.20.5 the packet carries a `SpawnInfo` container instead and the name sits inside it, beside the
 * dimension *type* it must not be confused with. Reading only the old field is how every Multiverse
 * world quietly ended up filed under `overworld`.
 */
function levelNameOf(packet: unknown): string | undefined {
  const held = packet as { worldName?: unknown; worldState?: { name?: unknown } }

  if (typeof held.worldName === 'string') return held.worldName
  if (typeof held.worldState?.name === 'string') return held.worldState.name
  return undefined
}

/** A duration an operator reads rather than counts: `3 seconds`, `12 minutes`, `2 hours`.
 *
 * One unit, deliberately. "Kicked after 3 seconds" and "kicked after 6 hours" are different
 * diagnoses and that is the whole value of the number; the remainder is noise. */
export function lasted(since: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - since) / 1000))
  if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`

  const minutes = Math.round(seconds / 60)
  if (minutes < 120) return `${minutes} minutes`

  return `${Math.round(minutes / 60)} hours`
}
