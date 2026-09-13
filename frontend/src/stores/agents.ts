import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  api,
  errorMessage,
  type AgentInventoryResponse,
  type AgentPathResponse,
  type AgentResponse,
  type HostResponse,
  type SchematicResponse,
  type UserResponse,
} from '../api/client'
import { openLiveUpdates, type LiveUpdateHandle } from '../api/liveUpdates'
import {
  addJobAgent,
  assignSegment,
  pauseJob,
  deleteJob,
  listJobs,
  leaveJob,
  releaseSegment,
  resumeJob,
  startJob,
  type BuildJob,
  type SplitMode,
} from '../api/jobs'
import { useAuthStore } from './auth'
import { useToastStore } from './toasts'
import { t } from '../i18n'
import { jobFigures } from '../lib/jobs'
import { isOnline } from '../lib/agentState'
import {
  agentNotice,
  hostPage,
  JOBS_PAGE,
  pathNotice,
  schematicNotice,
  type Notice,
} from '../lib/announce'

/**
 * Fleet state.
 *
 * Hosts, agents, their lifecycle states, chat, activity, **telemetry** and **build progress** all
 * come from the backend. Nothing here is invented any more: the last mock was blocks placed, and it
 * went when a host could be asked how far it had got.
 *
 * Chat and activity are not held here. They are cursor-paged feeds owned by whichever view shows
 * one; the store only hands on the live lines as they arrive. See `src/lib/feed.ts`.
 */

/**
 * Telemetry is **absent, not zeroed**, when an agent has not reported recently. Zeroes would render
 * as an agent on 0 health standing at the origin, which is a very convincing way to describe an
 * agent nobody has heard from.
 */
export type AgentTelemetry = NonNullable<AgentResponse['telemetry']>

/**
 * An inventory is **absent, not empty**, until an agent reports one.
 *
 * The same distinction the telemetry makes, and it matters more here: an empty grid is a perfectly
 * ordinary thing for an agent to be carrying, so drawing one for an agent that has said nothing is
 * not a blank screen but a wrong answer.
 */
export type AgentInventory = AgentInventoryResponse

/**
 * Where an agent is going, while it is going somewhere.
 *
 * **Live only.** An old position is still the only answer there is about where somebody was; an old
 * path is simply wrong about where somebody is going. The backend holds one for exactly as long as
 * the journey lasts, so an agent that is not walking has none rather than a stale one.
 */
export type AgentPath = AgentPathResponse
export type NearbyPlayer = AgentTelemetry['nearby'][number]

/**
 * An agent as the fleet holds it.
 *
 * **Was `AgentResponse & { build }`**, where `build` carried an invented block count and a task
 * string nothing ever rendered. Both are gone: what an agent is building is a fact about a job,
 * read through `assignmentOf`, and how far along it is comes from the host that is building it.
 */
export type FleetAgent = AgentResponse

/**
 * What an agent is building, when it is building something.
 *
 * Carries the counts as well as the names, because the agent page shows how far along its own
 * segment is — which used to be an invented number on the agent itself.
 */
export interface Assignment {
  jobId: number
  buildName: string
  ordinal: number
  blocksPlaced: number
  blocks: number
}

export interface Attention {
  agent: FleetAgent
  reason: string
  severity: 'error' | 'warning'
}

/** A Minecraft server and how much of the fleet is on it. */
export interface ServerSummary {
  address: string
  online: number
  total: number
  /** The agent forwarding this server's global chat, or undefined when nothing is listening. */
  listener: FleetAgent | undefined
}

// Defined in `src/lib/agentState.ts` and re-exported here, where most callers already look for it.
export { isOnline }

export const useAgentStore = defineStore('agents', () => {
  const hosts = ref<HostResponse[]>([])
  const agents = ref<FleetAgent[]>([])
  const jobs = ref<BuildJob[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  // ---- loading -------------------------------------------------------------------------------

  /**
   * `loaded` is what tells an empty fleet apart from one nobody has asked for yet.
   *
   * Without it every list has to render its empty state during the first request, so a fresh page
   * says "No hosts yet." before it has any idea whether that is true. It stays true afterwards: a
   * later refresh is a background update over content that is already on screen, and blanking it
   * back to skeletons would be a worse lie than briefly stale numbers.
   */
  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await Promise.all([loadHosts(), loadAgents(), loadJobs(), loadPaths()])
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  async function loadHosts(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/hosts')
    if (failure) {
      error.value = errorMessage(failure, t('errors.loadHosts'))
      return
    }
    hosts.value = (data ?? []) as HostResponse[]
  }

  async function loadAgents(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/agents')
    if (failure) {
      error.value = errorMessage(failure, t('errors.loadAgents'))
      return
    }
    agents.value = (data ?? []) as AgentResponse[]
  }

  /**
   * What the fleet has been given to build.
   *
   * Held here rather than by the panel that shows them, because an agent's assignment is a fact
   * about the agent: it is what the fleet list needs to say which bots are on a build, and the
   * list has no business fetching them to find out.
   */
  async function loadJobs(): Promise<void> {
    // Reading jobs needs the same node as reading agents, so anyone who got this far may ask.
    try {
      jobs.value = await listJobs()
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : t('errors.generic')
    }
  }

  /**
   * Which agent is on which piece, for the agents that are on one.
   *
   * Only live assignments: a finished or released segment is not something an agent is doing, and
   * a badge that outlived the work would be worse than none.
   */
  const assignments = computed(() => {
    const held = new Map<number, Assignment>()
    for (const job of jobs.value) {
      if (job.state !== 'ACTIVE') continue
      for (const segment of job.segments) {
        if (segment.agentId === null) continue
        if (segment.state !== 'ASSIGNED' && segment.state !== 'BUILDING') continue
        held.set(segment.agentId, {
          jobId: job.id,
          buildName: job.buildName,
          ordinal: segment.ordinal,
          blocksPlaced: segment.blocksPlaced,
          blocks: segment.blocks,
        })
      }
    }
    return held
  })

  function assignmentOf(agentId: number) {
    return assignments.value.get(agentId) ?? null
  }

  /**
   * Which job an agent is **on**, holding a piece or not.
   *
   * Not the same question as [assignments], and the difference is the whole point of the pool. An
   * agent waiting for the floor beneath its next piece to be finished is on a job and building
   * nothing; asking what it holds calls it free, and every picker that asked that offered it to a
   * second job the backend then refused.
   */
  const memberships = computed(() => {
    const on = new Map<number, { jobId: number; buildName: string }>()
    for (const job of unfinished.value) {
      for (const member of job.pool) {
        if (member.agentId === null) continue
        on.set(member.agentId, { jobId: job.id, buildName: job.buildName })
      }
    }
    return on
  })

  function jobOf(agentId: number) {
    return memberships.value.get(agentId) ?? null
  }

  /**
   * Whether this agent is on a build right now.
   *
   * The badge and the sidebar dot ask only this, and asking it here keeps `lib/agentState` free of
   * the store — those helpers are imported by the store itself, and the cycle that would make has
   * already bitten this project once.
   */
  function isBuilding(agentId: number): boolean {
    return assignments.value.has(agentId)
  }

  // ---- live updates --------------------------------------------------------------------------

  /**
   * The stream carries the same shapes the REST endpoints return, so an event is applied in place
   * rather than triggering a refetch. That is what makes a change another operator made — or one a
   * host reported with nobody watching — appear without polling.
   */
  let connection: LiveUpdateHandle | null = null
  const liveUpdatesConnected = ref(false)

  /**
   * Whether the stream has been up before in this session.
   *
   * The first connect follows the load that opened the screen, and refetching on top of it would be
   * the same three requests twice. Every connect after it is a reconnect - see below.
   */
  let streamed = false

  function connectLiveUpdates(): void {
    if (connection) return
    connection = openLiveUpdates('/api/stream', {
      onEvent: applyEvent,
      onConnect() {
        liveUpdatesConnected.value = true

        /*
         * **A reconnect refetches, because the stream carries no backlog.** Events published while
         * it was down are simply gone: the backend broadcasts to whoever is attached, and a client
         * that was not gets nothing on its return. Every one of them was a change to what is on
         * screen, and nothing else would ever correct it - the fleet is applied in place precisely
         * so that it does not poll.
         *
         * What that looked like: a backend restart, or a laptop that slept, and the page carried on
         * showing an agent as still trying to rejoin long after it had given up - with the button
         * to stop it enabled, over a backend that answered "it is not trying to be".
         */
        if (streamed) void refresh()
        streamed = true
      },
      onDisconnect() {
        liveUpdatesConnected.value = false
      },
    })
  }

  function disconnectLiveUpdates(): void {
    connection?.close()
    connection = null
    liveUpdatesConnected.value = false
  }

  /**
   * The seam between transport and state: everything the stream delivers lands here. Exported so
   * the ingest can be exercised without standing up a socket, and so a future transport swap is one
   * call site rather than a rewrite.
   */
  function applyEvent(name: string, data: unknown): void {
    switch (name) {
      case 'agent': {
        const incoming = data as AgentResponse
        announceAgent(
          agents.value.find((existing) => existing.id === incoming.id),
          incoming,
        )
        upsertAgent(incoming)
        break
      }
      case 'agent-removed': {
        const gone = (data as { id: number }).id
        agents.value = agents.value.filter((agent) => agent.id !== gone)
        // Otherwise the maps keep an inventory and a journey per agent that has ever existed in
        // this tab.
        if (paths.value.has(gone)) {
          const without = new Map(paths.value)
          without.delete(gone)
          paths.value = without
        }
        if (inventories.value.has(gone)) {
          const without = new Map(inventories.value)
          without.delete(gone)
          inventories.value = without
        }
        break
      }
      case 'host': {
        const host = data as HostResponse
        announceHost(
          hosts.value.find((existing) => existing.id === host.id),
          host,
        )
        upsertHost(host)
        break
      }
      case 'host-removed':
        hosts.value = hosts.value.filter((host) => host.id !== (data as { id: number }).id)
        break
      case 'telemetry':
        applyTelemetry(data as { agentId: number; telemetry: AgentTelemetry })
        break
      case 'path':
        announcePath(data as AgentPath)
        applyPath(data as AgentPath)
        break
      case 'inventory': {
        const incoming = data as { agentId: number; inventory: AgentInventory }
        inventories.value = new Map(inventories.value).set(incoming.agentId, incoming.inventory)
        break
      }
      case 'permissions':
        // Not fleet state, but there is one stream and therefore one ingest. The backend enforces a
        // role change on the next request either way; this is what stops the UI from going on
        // offering buttons that now fail, which reads as a bug rather than as access having changed.
        useAuthStore().user = data as UserResponse
        break
      case 'chat':
      // A gap where lines were refused as repetition. Handed on like a line because it is drawn in
      // the same list - but it is live only, and a panel that was not open when it happened never
      // learns of it, because nothing was stored to learn from.
      case 'chat-suppressed':
      case 'activity':
      case 'audit':
      case 'user':
      case 'user-removed':
        // Paged lists, owned by whichever view is showing one, so these are handed on rather than
        // accumulated here: the store has no way to know which page a line belongs on.
        for (const listener of feedListeners) listener(name, data)
        break
      // Schematics are a list too, and one that moves on its own: an upload and the pass that
      // follows it run for minutes with nobody touching anything, so the view that shows them
      // needs the stream rather than a poll. Handed on the same way, and the end of that pass is
      // announced on the way through.
      case 'schematic':
        announceSchematic(data as SchematicResponse)
        for (const listener of feedListeners) listener(name, data)
        break
      case 'schematic-removed':
        schematicStatuses.delete((data as { id: number }).id)
        for (const listener of feedListeners) listener(name, data)
        break
      // A chunk an agent has just charted. Only a map on screen wants it, and that map already holds
      // the ground around it, so it is handed on rather than kept here.
      case 'map-tile':
        for (const listener of feedListeners) listener(name, data)
        break
      // Runs are not a paged list and not owned by one view: an agent's assignment is a fact about
      // the agent, which the fleet list reads without knowing anything about jobs. A job also moves
      // with nobody watching — a segment is freed the moment its agent leaves the game.
      case 'build-job': {
        const job = data as BuildJob
        announceJob(
          jobs.value.find((existing) => existing.id === job.id),
          job,
        )
        upsertJob(job)
        break
      }
      case 'build-job-removed':
        jobs.value = jobs.value.filter((job) => job.id !== (data as { id: number }).id)
        break
      // 'ready' and anything this build does not know about are ignored, so a newer backend
      // sending a new event type never breaks an older tab.
    }
  }

  /**
   * Live lines for whoever is displaying a paged list of them — chat, activity, the audit trail and
   * the account list.
   *
   * Returns its own unsubscribe, so a component drops the listener when it unmounts rather than the
   * store growing a registry of views. Everything else the stream carries is state the store owns,
   * which is why this exists only for the paged lists.
   */
  const feedListeners = new Set<(name: string, data: unknown) => void>()

  function onFeedEvent(listener: (name: string, data: unknown) => void): () => void {
    feedListeners.add(listener)
    return () => feedListeners.delete(listener)
  }

  /**
   * The two things the stream carries that an operator is waiting on and cannot see.
   *
   * **Only from the stream.** Every one of these can also arrive as the answer to a button the
   * operator just pressed, and telling somebody what they have this second done is noise — so this
   * hangs off the ingest rather than off `upsertJob`, which the action methods share.
   *
   * Nothing is said about a job being seen for the first time. A page that has just loaded, or a
   * tab that has just reconnected, would otherwise open with a column of notices about a backlog
   * nobody was waiting on.
   */
  function announceJob(previous: BuildJob | undefined, incoming: BuildJob): void {
    if (!previous) return
    const toasts = useToastStore()

    if (previous.state !== 'DONE' && incoming.state === 'DONE') {
      toasts.notify('success', 'toast.jobDone', { params: { name: incoming.buildName }, to: JOBS_PAGE })
    }

    // Per piece that has *become* failed, so a job carrying a failure does not re-announce it every
    // time anything else about the job moves — which, on a running job, is every few seconds.
    const failed = incoming.segments.filter(
      (segment) =>
        segment.state === 'FAILED' &&
        previous.segments.find((was) => was.id === segment.id)?.state !== 'FAILED',
    )

    // One notice per job rather than per piece, which falls out of the copy rather than being
    // arranged here: every piece of the same job produces the same sentence, and the same sentence
    // twice is one card counting two. A host that cannot build one box usually cannot build the
    // next either, and twenty lines saying so is a worse account of it than one saying twenty.
    for (let remaining = failed.length; remaining > 0; remaining -= 1) {
      toasts.notify('warning', 'toast.segmentFailed', { params: { name: incoming.buildName }, to: JOBS_PAGE })
    }
  }

  /**
   * A host going quiet, which takes every agent on it offline.
   *
   * Only the fall. A host coming back is good news that announces itself the moment anything on the
   * page moves again, and a flapping connection would otherwise post two notices a minute.
   */
  function announceHost(previous: HostResponse | undefined, incoming: HostResponse): void {
    if (!previous?.reachable || incoming.reachable) return
    useToastStore().notify('warning', 'toast.hostUnreachable', {
      params: { name: incoming.name },
      to: hostPage(incoming.id),
    })
  }

  function tell(notice: Notice | null): void {
    if (!notice) return
    useToastStore().notify(notice.kind, notice.key, {
      params: notice.params,
      to: notice.to,
      ...(notice.fade ? { fade: true } : {}),
      ...(notice.topic !== undefined ? { topic: notice.topic } : {}),
    })
  }

  /**
   * Agents this tab has just told to leave the game, so their leaving is not announced back to the
   * operator who pressed the button. Spent once the agent is out and nothing is bringing it back.
   */
  const leaving = new Set<number>()

  /** An agent leaving the game, or failing to get into it. See `agentNotice` for which. */
  function announceAgent(previous: AgentResponse | undefined, incoming: AgentResponse): void {
    const asked = leaving.has(incoming.id)
    tell(agentNotice(previous, incoming, asked))

    if (asked && incoming.state !== 'ONLINE' && incoming.state !== 'CONNECTING' && !incoming.rejoining) {
      leaving.delete(incoming.id)
    }
  }

  /** How a journey ended, and a route that only gets as close as it can. See `pathNotice`. */
  function announcePath(incoming: AgentPath): void {
    const agent = agents.value.find((existing) => existing.id === incoming.agentId)
    if (agent) tell(pathNotice(incoming, agent.label))
  }

  /**
   * The last status seen per schematic, which is what tells a pass finishing from a rename.
   *
   * Plain rather than reactive: nothing draws it, and a schematic nobody saw being read is one this
   * tab has no business announcing.
   */
  const schematicStatuses = new Map<number, SchematicResponse['status']>()

  function announceSchematic(incoming: SchematicResponse): void {
    tell(schematicNotice(schematicStatuses.get(incoming.id), incoming))
    schematicStatuses.set(incoming.id, incoming.status)
  }

  function upsertJob(incoming: BuildJob): void {
    const index = jobs.value.findIndex((job) => job.id === incoming.id)
    if (index === -1) jobs.value = [incoming, ...jobs.value]
    else jobs.value[index] = incoming
  }

  function upsertAgent(incoming: AgentResponse): void {
    const index = agents.value.findIndex((agent) => agent.id === incoming.id)
    if (index === -1) agents.value = [...agents.value, incoming]
    else agents.value[index] = incoming
  }

  /**
   * Vitals arrive on their own event, several times a minute per agent, so they are merged into the
   * agent in place. The alternative — resending the whole agent each tick — is what the split event
   * exists to avoid.
   */
  function applyTelemetry(incoming: { agentId: number; telemetry: AgentTelemetry }): void {
    const index = agents.value.findIndex((agent) => agent.id === incoming.agentId)
    if (index === -1) return
    agents.value[index] = { ...agents.value[index]!, telemetry: incoming.telemetry }
  }

  /**
   * What each agent is carrying, for whoever is looking at one.
   *
   * Kept here rather than in the card because the live stream is opened once, by the store: an
   * inventory arrives whether or not anybody has the page open, and a card that owned this would
   * have to be mounted to receive it.
   *
   * Never cleared on its own. An agent that stops reporting has its inventory aged out by the
   * backend, which answers the next read with nothing - so what is on screen goes stale for as long
   * as the page stays open, and is corrected the moment anybody asks again. Holding a timer here to
   * blank it would be inventing a second answer to a question the backend already answers.
   */
  const inventories = ref(new Map<number, AgentInventory>())

  /** What an agent is carrying, or null when it has not reported. */
  function inventoryOf(id: number): AgentInventory | null {
    return inventories.value.get(id) ?? null
  }

  /**
   * Where each agent is going, for whoever is watching.
   *
   * Here rather than on the agent itself, for the reason the inventory is: a journey arrives on its
   * own event several times a second while a change to the agent is rare and meaningful, and folding
   * one into the other would turn the second into the first.
   */
  const paths = ref(new Map<number, AgentPath>())

  /** The journey this agent is on, or null when it is not on one. */
  function pathOf(id: number): AgentPath | null {
    return paths.value.get(id) ?? null
  }

  /**
   * Every journey in progress, for a screen that has just opened.
   *
   * The fleet's in one request rather than one per agent: the map draws every agent in a world, and
   * asking per agent to learn that most of them are standing still is a request per agent too many.
   */
  async function loadPaths(): Promise<void> {
    const { data, error: failure } = await api.GET('/api/agents/paths')
    if (failure) {
      error.value = errorMessage(failure, t('errors.loadPaths'))
      return
    }
    paths.value = new Map(((data ?? []) as AgentPath[]).map((path) => [path.agentId, path]))
  }

  /**
   * Applies one journey update.
   *
   * **Merged, not replaced.** Most of these carry only how far along the agent has got: the line is
   * sent when it is drawn and again on every re-plan, because a few hundred points a second would be
   * bandwidth spent redrawing something that moved by one node. Replacing would blank the path on
   * the first progress report - which is the update immediately after it.
   *
   * A journey that has ended is dropped rather than kept in its final state. The line stops being
   * drawn, which is the point; what happened to it is the caller's to say, from this same event.
   */
  function applyPath(incoming: AgentPath): void {
    const next = new Map(paths.value)

    if (incoming.state !== 'PLANNING' && incoming.state !== 'MOVING') {
      next.delete(incoming.agentId)
      paths.value = next
      return
    }

    const held = next.get(incoming.agentId)
    next.set(incoming.agentId, {
      ...incoming,
      dimension: incoming.dimension ?? held?.dimension ?? null,
      goal: incoming.goal ?? held?.goal ?? null,
      nodes: incoming.nodes ?? held?.nodes ?? null,
      // Held for the same reason the line is: most updates carry only how far along the agent has
      // got, and the spread above would blank the boxes on the first progress report after them.
      work: incoming.work ?? held?.work ?? null,
    })
    paths.value = next
  }

  /**
   * Sends an agent somewhere.
   *
   * Nothing is written here. The path does not exist yet - only the host can see the blocks, so it
   * plans and then says what it found. Drawing a straight line to the destination now and replacing
   * it a moment later reads as the agent changing its mind about a route it never had.
   */
  async function sendTo(id: number, waypoints: Array<{ x: number; y?: number; z: number }>): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/path', {
      params: { path: { id } },
      body: { waypoints },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.sendTo')))
  }

  /** Stops an agent where it is. The host answers with an `IDLE`, which is what clears the line. */
  async function stopPath(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/agents/{id}/path', {
      params: { path: { id } },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.stopPath')))
  }

  /**
   * Fetches an agent's inventory once, for a page that has just opened.
   *
   * The live stream keeps it current afterwards, so this is only ever about the gap between opening
   * a page and the next time an item moves - which for an agent standing still is forever.
   */
  async function loadInventory(id: number): Promise<void> {
    const { data, error: failure, response } = await api.GET('/api/agents/{id}/inventory', {
      params: { path: { id } },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.loadInventory')))

    // 204 means the agent has not reported one, which is an answer rather than a failure. Dropped
    // rather than stored as empty: an empty grid is what an agent carrying nothing looks like.
    if (response.status === 204 || !data) {
      const without = new Map(inventories.value)
      without.delete(id)
      inventories.value = without
      return
    }
    inventories.value = new Map(inventories.value).set(id, data as AgentInventory)
  }

  /**
   * Moves an item between two squares.
   *
   * Nothing is written here. What the agent is carrying is the host's to say, and moving the item
   * locally would show the move as done before the server had agreed to it - then quietly disagree
   * with the report that follows.
   */
  async function moveItem(id: number, from: number, to: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/inventory/move', {
      params: { path: { id } },
      body: { from, to },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.moveItem')))
  }

  /**
   * Puts a hotbar square in the agent's hand.
   *
   * A separate verb rather than a move onto a special slot, because it is a different kind of
   * change: what an agent holds decides what it hits, places and eats with, and nothing about it
   * moves an item anywhere.
   */
  async function holdItem(id: number, slot: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/inventory/hold', {
      params: { path: { id } },
      body: { slot },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.holdItem')))
  }

  /** Throws a square's contents on the ground. An absent count throws the whole stack. */
  async function dropItem(id: number, slot: number, count?: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/inventory/drop', {
      params: { path: { id } },
      body: { slot, ...(count === undefined ? {} : { count }) },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.dropItem')))
  }

  function upsertHost(incoming: HostResponse): void {
    const index = hosts.value.findIndex((host) => host.id === incoming.id)
    if (index === -1) hosts.value = [...hosts.value, incoming]
    else hosts.value[index] = incoming
  }

  // ---- derived -------------------------------------------------------------------------------

  const online = computed(() => agents.value.filter(isOnline))

  /**
   * Jobs that still describe work.
   *
   * A finished job keeps its blocks for as long as its record exists, and counting those into a
   * dashboard reading *now* would show a fleet that has just started as most of the way through
   * something it finished last week.
   */
  const unfinished = computed(() => jobs.value.filter((job) => job.state !== 'DONE'))

  /**
   * What the fleet is building, from what hosts have actually reported.
   *
   * The arithmetic lives in `src/lib/jobs.ts` so the dashboard can ask the same question of one
   * server's jobs. That scoping is no longer a nicety: a job *is* per-server, so a fleet-wide
   * figure is a sum across separate builds and only means anything as a total.
   */
  const fleetBuild = computed(() => jobFigures(unfinished.value))

  const blocksPlaced = computed(() => fleetBuild.value.placed)

  const progressPercent = computed(() => fleetBuild.value.percent)

  const blocksPerMinute = computed(() => fleetBuild.value.perMinute)

  const etaMinutes = computed(() => fleetBuild.value.etaMinutes)

  /** The unfinished jobs on one server, or all of them when nothing is picked. */
  function jobsOn(server: string | null): BuildJob[] {
    return server === null
      ? unfinished.value
      : unfinished.value.filter((job) => job.serverAddress === server)
  }
  /**
   * Distinct servers in the fleet. A server is a scope: listener, chat feed and build hang off it.
   *
   * Agents assigned nowhere contribute none. That is the point of allowing it — an agent that is set
   * up and waiting for work used to be parked on a server it was not connected to, which then
   * appeared here with nobody on it.
   */
  const servers = computed(() =>
    [...new Set(agents.value.map((agent) => agent.serverAddress).filter((it) => it !== null))].sort(),
  )

  /**
   * Each server with its share of the fleet, and the agent forwarding its global chat.
   *
   * The listener is **read, not computed**. Election is backend-side — only it sees the whole fleet,
   * and agents on one server can be spread across several hosts — and `chatListener` reports which
   * agent was actually told to forward. Working it out here would be a guess that quietly disagrees
   * with what the agents are doing. A server with nobody listening has no global feed, which is
   * honest rather than a gap to paper over.
   */
  const serverSummaries = computed<ServerSummary[]>(() =>
    servers.value.map((address) => {
      const here = agents.value.filter((agent) => agent.serverAddress === address)
      return {
        address,
        online: here.filter(isOnline).length,
        total: here.length,
        listener: here.find((agent) => agent.chatListener),
      }
    }),
  )

  const attention = computed<Attention[]>(() => {
    const found: Attention[] = []
    for (const agent of agents.value) {
      if (agent.state === 'STALE') {
        found.push({ agent, reason: t('attention.hostUnreachable'), severity: 'error' })
        continue
      }
      if (agent.state === 'NEEDS_RELINK') {
        found.push({ agent, reason: t('attention.needsRelink'), severity: 'error' })
        continue
      }
      if (!isOnline(agent)) continue

      // An agent that has not reported raises nothing. Silence is not a healthy reading, but it is
      // not a low one either — inventing an alert from missing data is how a dashboard cries wolf.
      const vitals = agent.telemetry
      if (!vitals) continue

      if (vitals.health <= 10) {
        found.push({ agent, reason: `${t('agents.health')} ${vitals.health}/20`, severity: 'error' })
      }
      if (vitals.food <= 8) {
        found.push({ agent, reason: `${t('agents.food')} ${vitals.food}/20`, severity: 'warning' })
      }
      if (vitals.pingMs >= 100) {
        found.push({ agent, reason: `${t('agents.ping')} ${vitals.pingMs} ms`, severity: 'warning' })
      }
    }
    return found.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  })

  function byId(id: number): FleetAgent | undefined {
    return agents.value.find((agent) => agent.id === id)
  }

  function hostById(id: number): HostResponse | undefined {
    return hosts.value.find((host) => host.id === id)
  }

  function agentsOnHost(hostId: number): FleetAgent[] {
    return agents.value.filter((agent) => agent.hostId === hostId)
  }

  // ---- commands ------------------------------------------------------------------------------

  /**
   * Every command can legitimately fail with 503 while no host is connected.
   *
   * None of these refetch afterwards. Anything that changes stored state publishes an event, which
   * arrives before the response is written, so a refetch would only re-read what the stream has
   * already applied. Connect, disconnect and chat change nothing stored at all — the state moves
   * when the host reports back.
   */
  async function enrolHost(name: string): Promise<string> {
    const { data, error: failure } = await api.POST('/api/hosts', { body: { name } })
    if (failure || !data?.token) throw new Error(errorMessage(failure, t('errors.enrolHost')))
    return data.token
  }

  async function renameHost(id: number, name: string): Promise<void> {
    const { error: failure } = await api.PATCH('/api/hosts/{id}', {
      params: { path: { id } },
      body: { name },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.renameHost')))
  }

  /** Returns the replacement token, shown once. The host's current connection is closed. */
  async function rotateHostToken(id: number): Promise<string> {
    const { data, error: failure } = await api.POST('/api/hosts/{id}/rotate-token', {
      params: { path: { id } },
    })
    if (failure || !data?.token) throw new Error(errorMessage(failure, t('errors.rotateToken')))
    return data.token
  }

  // ---- jobs ----------------------------------------------------------------------------------

  /**
   * Every act on a job, wrapped so the answer is applied here rather than waited on.
   *
   * The stream carries the same change a moment later and applying it twice is idempotent — but a
   * panel where an operator's own click appears to do nothing until an unrelated socket catches up
   * is the failure this whole page exists to avoid.
   */
  async function beginJob(
    buildId: number,
    mode: SplitMode,
    agentIds: number[],
    parts: number | null = null,
  ): Promise<BuildJob> {
    const job = await startJob(buildId, { mode, agentIds, ...(parts ? { parts } : {}) })
    upsertJob(job)
    return job
  }

  async function stopJob(id: number): Promise<BuildJob> {
    const job = await pauseJob(id)
    upsertJob(job)
    return job
  }

  async function restartJob(id: number): Promise<BuildJob> {
    const job = await resumeJob(id)
    upsertJob(job)
    return job
  }

  async function giveSegment(jobId: number, segmentId: number, agentId: number): Promise<BuildJob> {
    const job = await assignSegment(jobId, segmentId, agentId)
    upsertJob(job)
    return job
  }

  async function freeSegment(jobId: number, segmentId: number): Promise<BuildJob> {
    const job = await releaseSegment(jobId, segmentId)
    upsertJob(job)
    return job
  }

  async function joinJob(jobId: number, agentId: number): Promise<BuildJob> {
    const job = await addJobAgent(jobId, agentId)
    upsertJob(job)
    return job
  }

  async function leavePool(jobId: number, agentId: number): Promise<BuildJob> {
    const job = await leaveJob(jobId, agentId)
    upsertJob(job)
    return job
  }

  async function removeJob(id: number): Promise<void> {
    await deleteJob(id)
    jobs.value = jobs.value.filter((job) => job.id !== id)
  }

  async function removeHost(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/hosts/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, t('errors.removeHost')))
  }

  async function addAgent(input: {
    label: string
    hostId: number
    serverAddress: string | null
  }): Promise<AgentResponse> {
    const { data, error: failure } = await api.POST('/api/agents', { body: input })
    if (failure || !data) throw new Error(errorMessage(failure, t('errors.createAgent')))
    return data as AgentResponse
  }

  /** Rename. Where an agent plays is [assignServer], which has its own preconditions. */
  async function updateAgent(id: number, changes: { label?: string }): Promise<void> {
    const { error: failure } = await api.PATCH('/api/agents/{id}', {
      params: { path: { id } },
      body: changes,
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.updateAgent')))
  }

  /**
   * Points an agent at a Minecraft server, or at none — pass null to unassign.
   *
   * Separate from the rename because it is a different kind of change: it decides what the next
   * connection targets, so the backend refuses it while the agent is online.
   */
  async function assignServer(id: number, serverAddress: string | null): Promise<void> {
    const { error: failure } = await api.PUT('/api/agents/{id}/server', {
      params: { path: { id } },
      body: { serverAddress },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.assignServer')))
  }

  async function removeAgent(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/agents/{id}', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, t('errors.removeAgent')))
  }

  async function setupAgent(id: number, method: string): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/setup', {
      params: { path: { id } },
      body: { method },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.setUpAgent')))
  }

  /**
   * Stops waiting on a setup, which is not the same as cancelling the login.
   *
   * Nothing reaches the host — Osmium cannot cancel a sign-in it does not perform. It returns the
   * agent to UNLINKED so it can be set up again, and a host that finishes the original login
   * afterwards still reports and still links it.
   */
  async function cancelSetup(id: number): Promise<void> {
    const { error: failure } = await api.DELETE('/api/agents/{id}/setup', {
      params: { path: { id } },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.cancelSetup')))
  }

  async function connect(id: number): Promise<void> {
    const { error: failure } = await api.POST('/api/agents/{id}/connect', { params: { path: { id } } })
    if (failure) throw new Error(errorMessage(failure, t('errors.connectAgent')))
  }

  async function disconnect(id: number): Promise<void> {
    // Before the request: the host can answer on the stream before this one returns.
    leaving.add(id)
    const { error: failure } = await api.POST('/api/agents/{id}/disconnect', {
      params: { path: { id } },
    })
    if (failure) {
      leaving.delete(id)
      throw new Error(errorMessage(failure, t('errors.disconnectAgent')))
    }
  }

  async function say(id: number, message: string): Promise<void> {
    if (!message.trim()) return
    const { error: failure } = await api.POST('/api/agents/{id}/chat', {
      params: { path: { id } },
      body: { message: message.trim() },
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.sendMessage')))
  }

  return {
    hosts,
    agents,
    jobs,
    unfinished,
    jobsOn,
    assignments,
    assignmentOf,
    jobOf,
    isBuilding,
    loadJobs,
    beginJob,
    stopJob,
    restartJob,
    giveSegment,
    freeSegment,
    joinJob,
    leavePool,
    removeJob,
    loading,
    loaded,
    error,
    liveUpdatesConnected,
    connectLiveUpdates,
    applyEvent,
    onFeedEvent,
    disconnectLiveUpdates,
    online,
    servers,
    serverSummaries,
    blocksPlaced,
    progressPercent,
    blocksPerMinute,
    etaMinutes,
    attention,
    refresh,
    byId,
    hostById,
    agentsOnHost,
    enrolHost,
    renameHost,
    rotateHostToken,
    removeHost,
    addAgent,
    updateAgent,
    assignServer,
    removeAgent,
    setupAgent,
    cancelSetup,
    connect,
    disconnect,
    say,
    inventoryOf,
    loadInventory,
    paths,
    pathOf,
    loadPaths,
    sendTo,
    stopPath,
    moveItem,
    dropItem,
    holdItem,
  }
})

/**
 * How long the agent has been in game, from `onlineSince`. Derived rather than reported: the backend
 * already stamps the moment an agent enters the game, for chat listener election, so a second
 * uptime counter on the wire would be one more thing that could disagree with it.
 */
export function uptimeOf(agent: AgentResponse): string {
  if (!agent.onlineSince) return '—'
  return formatUptime(Math.floor((Date.now() - new Date(agent.onlineSince).getTime()) / 1000))
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
}
