import { Agent, type Credential } from '../agent/bot.ts'
import { log } from '../log.ts'
import type { AgentSnapshot, Command, Event, Outbound, SetupResult } from '../protocol/message.ts'
import { ActivityScope, LoginState, Severity } from '../protocol/wire.ts'
import { advertised, isInteractive, kindFromId, LoginKind, type StoredKind } from '../token/login.ts'
import type { Proxies } from '../agent/proxy.ts'
import { add, type Bytes, NO_BYTES } from '../agent/traffic.ts'
import type { AccountStore } from '../token/store.ts'

interface Running {
  agent: Agent
  /** Command ids waiting on an answer, oldest first. Only `setup_agent` is ever answered. */
  pending: string[]
  /** What this agent was last known to be doing, for the arrival announcement.
   *
   * Tracked here rather than asked of the agent, because the announcement goes out the moment a
   * socket comes up and cannot wait on a round trip to every agent to answer it. */
  state: LoginState
}

/**
 * Routes what arrives on the socket to the agent it names, and everything an agent says back out.
 */
export class Dispatcher {
  private readonly agents = new Map<number, Running>()
  /** What agents that are gone moved, so the host's total never goes backwards when one is deleted. */
  private departed: Bytes = NO_BYTES

  constructor(
    private readonly store: AccountStore,
    private readonly cacheDirectory: string,
    /** What this host can route a session through. Named in a setting, resolved here. */
    private readonly proxies: Proxies,
    private readonly send: (message: Outbound) => void,
    /** World updates. They ride the same socket as a binary frame, and are relayed rather than
     * read - nothing between here and the browser has any use for what is in them. */
    private readonly stream: (frame: Buffer) => void,
  ) {}

  /**
   * Everything this host was already running, rebuilt from the store.
   *
   * Agents live only in this map, and only `setup_agent` ever creates one - so a restart would
   * otherwise leave the backend reporting agents as LINKED, which is a claim about credentials and
   * true, while `connect` reached a host that had never heard of them. The binding in the store is
   * what makes them recoverable without asking the operator to set everything up again.
   */
  restore(): void {
    for (const id of this.store.boundAgents()) {
      const entry = this.store.restore(id)
      if (!entry) continue

      log.info(`Rebuilding agent ${id} from the account store`)
      this.start(id, { kind: 'restored', entry })
    }
  }

  /**
   * The first frame on a new socket: what we are running, and what we can log in with.
   *
   * The only message that says what *exists*. Agent state is stored on the backend and outlives the
   * connection that reported it, so without this a host that restarted would leave Osmium asserting
   * sessions nobody is running - and an empty list is a real announcement saying exactly that.
   */
  announce(): void {
    const agents: AgentSnapshot[] = [...this.agents].map(([agentId, running]) => ({ agentId, state: running.state }))

    this.send({
      kind: 'event',
      body: { type: 'handshake', agents, loginMethods: advertised(), proxies: this.proxies.advertised() },
    })

    // Everything the backend holds only in memory has to be said again, because a new socket may
    // well be a new backend - and one that has never heard of this host's agents. Inventories are
    // reported on change and deduplicated, so without this an agent that is standing still would
    // have nothing to say until it next picked something up, and its card would sit empty.
    for (const running of this.agents.values()) running.agent.restate()
  }

  /** Bytes every agent on this host has moved to and from its server since the host started. */
  traffic(): Bytes {
    let total = this.departed
    for (const running of this.agents.values()) total = add(total, running.agent.traffic())
    return total
  }

  command(command: Command): void {
    const { id, agentId, body } = command
    log.debug(`Agent ${agentId} was sent ${body.type}`)

    if (body.type === 'setup_agent') return void this.setup(id, agentId, body.method)

    const running = this.agents.get(agentId)

    if (!running) {
      // Not an error for `delete_agent`: it asks us to hold nothing for this agent, which holding
      // nothing already satisfies. The binding is still cleared, in case an agent was set up and
      // this process never rebuilt it.
      if (body.type === 'delete_agent') {
        void this.store.release(agentId).catch((err) => log.warn(`Agent ${agentId} left a binding behind: ${err}`))
        return
      }

      log.warn(`Ignoring ${body.type} for unknown agent ${agentId}`)
      return
    }

    running.agent.handle(body)
  }

  private setup(id: string, agentId: number, method: string): void {
    const kind = kindFromId(method)

    if (!kind) {
      // The backend checks the method against what we advertised before it sends, so this is the
      // race where our list changed in between - an ordinary failed setup, not something to drop on
      // the floor.
      log.warn(`Ignoring unknown login method '${method}'`)
      this.tellOperator(agentId, Severity.Error, `This host cannot log in with '${method}'.`)
      this.answer(id, agentId, { ok: false, reason: 'Unsupported login method' })
      return
    }

    if (this.agents.has(agentId)) {
      log.warn(`Agent ${agentId} is already set up`)
      this.answer(id, agentId, { ok: false, reason: 'This agent is already set up on this host' })
      return
    }

    if (isInteractive(kind)) {
      // Nothing to hand out. Performing the mechanism is what creates the credential, and that
      // happens inside the agent because it waits on a person.
      this.start(agentId, { kind: 'device_code' }, id)
      return
    }

    void this.claim(id, agentId, kind as StoredKind)
  }

  private async claim(id: string, agentId: number, kind: StoredKind): Promise<void> {
    const entry = await this.store.claim(kind, agentId).catch((err) => {
      // The credential may be usable, but an agent whose binding was not written is one the next
      // restart cannot rebuild.
      log.error(`Could not record which agent owns a credential: ${err}`)
      return undefined
    })

    if (!entry) {
      this.tellOperator(agentId, Severity.Warning, exhausted(kind))
      this.answer(id, agentId, { ok: false, reason: 'No accounts available' })
      return
    }

    this.start(agentId, { kind: 'stored', entry }, id)
  }

  private start(agentId: number, credential: Credential, pending?: string): void {
    // Declared before the agent and filled in after it, because the hooks below close over it. They
    // are only ever called from an awaited continuation, so it is in place long before any of them
    // runs.
    let running: Running

    const agent = new Agent(agentId, credential, this.store, this.cacheDirectory, this.proxies, {
      event: (event) => this.forward(agentId, event),
      viewer: (frame) => this.stream(frame),
      result: (setup) => {
        const id = running.pending.shift()
        if (id === undefined) {
          log.warn(`Agent ${agentId} answered a setup nobody asked for`)
          return
        }

        this.answer(id, agentId, setup)
      },
      finished: () => {
        if (this.agents.get(agentId) !== running) return
        this.departed = add(this.departed, running.agent.traffic())
        this.agents.delete(agentId)
      },
    })

    running = {
      agent,
      pending: pending === undefined ? [] : [pending],
      // We hold the credentials and are not in game. The agent corrects this the moment it knows
      // better; until then it is the only thing that is true.
      state: LoginState.LinkedCredentials,
    }

    this.agents.set(agentId, running)
  }

  private forward(agentId: number, event: Event): void {
    // Noted on the way past, so the next arrival announcement says what this agent is actually
    // doing rather than what it was doing when it was set up.
    if (event.type === 'agent_status' && event.state !== undefined) {
      const running = this.agents.get(agentId)
      if (running) running.state = event.state
    }

    this.send({ kind: 'event', body: event })
  }

  private answer(id: string, agentId: number, setup: SetupResult): void {
    this.send({ kind: 'result', body: { id, agentId, setup } })
  }

  /** Says something the operator will actually read.
   *
   * A setup result's `reason` is written for whoever reads host logs and never reaches them - all
   * they see is the agent going back to UNLINKED. Activity is the one channel that does reach them,
   * so anything they could act on has to go here. */
  private tellOperator(agentId: number, severity: Severity, text: string): void {
    this.send({
      kind: 'event',
      // Lifecycle rather than system: nothing happened *to* the agent, the setup simply did not
      // happen.
      body: { type: 'activity', agentId, scope: ActivityScope.Lifecycle, severity, text },
    })
  }
}

/** What to tell an operator who picked a method this host has run out of credentials for.
 *
 * Naming the way to add one, because there is nowhere else they would find out: the chooser they
 * just used is host-authored copy, and the failure itself is silent to them. */
function exhausted(kind: StoredKind): string {
  switch (kind) {
    case LoginKind.RefreshToken:
      return "Every Microsoft account on this host is already used by another agent. Set this agent up with 'Sign in with Microsoft' to add one, or delete an agent to free the account it holds."

    case LoginKind.MojangToken:
      return "This host holds no free Minecraft session token. One has to be added with 'osmium-link token'; nothing in Osmium can obtain one."

    // Unreachable: an offline identity is generated per agent rather than taken from a pool.
    case LoginKind.NoToken:
      return 'This host has no credential available for that method.'
  }
}
