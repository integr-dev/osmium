<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Boxes, Pause, Play, Trash2, Undo2, UserPlus, Users, X } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'
import type { BuildJob, JobAgent, JobSegment, JobState, JobType, SegmentState } from '../api/jobs'
import { summarise, type JobSummary } from '../lib/jobs'
import { atShort } from '../lib/time'
import { agentBadge, agentStateLabel } from '../lib/agentState'
import { JOB_ICON, jobBadge, jobProgress, jobStyle, jobUnit } from '../lib/jobKinds'
import { isOnline, useAgentStore, type FleetAgent } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import AgentPicker from './AgentPicker.vue'
import TabBar, { type Tab as Strip } from './TabBar.vue'

/**
 * Jobs: what the fleet is actually working on.
 *
 * A build job is a plan frozen — its own copy of the anchor and the rules — so nothing here reads
 * the build it came from. What is shown is what the agents were given, which is the only version
 * that describes the blocks going into the world.
 *
 * **Three kinds on one list.** A job is also a box being emptied or a footprint being charted, and
 * all three are the same thing to this panel: a crew, a division, and how far along each piece is.
 * What changes is the colour, the icon and what the count is counting — see `lib/jobKinds.ts`.
 *
 * **Only a build is dispatched.** A host knows how to be handed a box of blocks to place and
 * nothing else, so an excavation's pieces are assigned and stay assigned. The card says so rather
 * than leaving an operator to infer it from a bar that never moves.
 *
 * The jobs live in the fleet store rather than here. An agent's assignment is a fact about the
 * agent — the fleet list shows it too — and two copies of it would disagree the first time one of
 * them was refreshed.
 */
const { t, n } = useI18n()
const agentStore = useAgentStore()
const auth = useAuthStore()

const emit = defineEmits<{ done: [string]; failed: [string] }>()

/** Per job, so one cancel does not freeze the buttons on every other card. */
const busy = ref<Set<number>>(new Set())

/**
 * Which half of a card is showing, per job.
 *
 * The crew and the pieces are two lists over the same job and neither is a column of the other —
 * an agent can be on the build holding nothing, and a piece can be waiting with nobody on it. Both
 * open at once made a card long enough that the second job on the page was below the fold.
 */
const tabs = ref<Record<number, 'pieces' | 'pool'>>({})

/** A finished job has no crew — the pool is cleared — so it is only ever its pieces. */
function view(job: BuildJob): 'pieces' | 'pool' {
  return job.state === 'DONE' ? 'pieces' : (tabs.value[job.id] ?? 'pieces')
}

function show(job: BuildJob, which: 'pieces' | 'pool') {
  tabs.value[job.id] = which
}

/**
 * The words that change with the kind of work: a crew of diggers is not a crew of builders, and a
 * column counting cleared blocks is not headed *Built*.
 *
 * Only the ones that name the verb. Everything else on the card is the same act whichever tab made
 * the job — a crew, a division, how far along each piece is — and saying those three ways would be
 * three strings to keep in step for no gain.
 */
function word(job: BuildJob, which: 'crew' | 'member' | 'doing' | 'done' | 'unit'): string {
  return t(`jobs.words.${job.type}.${which}`)
}

/**
 * What a piece's state is called on this job.
 *
 * `BUILDING` and `DONE` are the two that name the work; the other three are about the piece and
 * read the same whoever is holding it.
 */
function segmentStateLabel(state: SegmentState, job: BuildJob): string {
  if (state === 'BUILDING') return word(job, 'doing')
  if (state === 'DONE') return word(job, 'done')
  return t(`jobs.segmentState.${state}`)
}

/** Per card, since both counts are that job's. */
function strip(job: BuildJob): Strip<'pieces' | 'pool'>[] {
  return [
    { id: 'pieces', label: t('jobs.tabPieces'), icon: Boxes, count: job.segments.length },
    { id: 'pool', label: word(job, 'crew'), icon: Users, count: job.pool.length },
  ]
}

/**
 * Which pieces a card is showing, per job.
 *
 * A build can be divided into sixty-four, and after an hour most of those rows are finished ones
 * an operator scrolls past to reach the two that need something. The filter is over states rather
 * than a free search because every question asked of this table is a state: what is being worked,
 * what is free, what failed.
 */
type Filter = 'all' | 'working' | 'free' | 'failed' | 'built'

const IN: Record<Exclude<Filter, 'all'>, SegmentState[]> = {
  // One chip: they differ only in whether the host has said it started, which is not a reason to
  // make somebody look in two places for the pieces that have an agent on them.
  working: ['ASSIGNED', 'BUILDING'],
  free: ['PENDING'],
  failed: ['FAILED'],
  built: ['DONE'],
}

const CHIPS: Array<{ id: Exclude<Filter, 'all'>; label: string }> = [
  { id: 'working', label: 'jobs.filterWorking' },
  { id: 'free', label: 'jobs.filterFree' },
  { id: 'failed', label: 'jobs.filterFailed' },
  // Named per kind in `filterStrip`; the label here is never read.
  { id: 'built', label: 'jobs.filterAll' },
]

const filters = ref<Record<number, Filter>>({})

/** What is selected, or everything until something else is. */
function filterOf(job: BuildJob): Filter {
  return filters.value[job.id] ?? 'all'
}

function only(job: BuildJob, which: Filter) {
  filters.value[job.id] = which
}

function counted(job: BuildJob, which: Exclude<Filter, 'all'>): number {
  return job.segments.filter((segment) => IN[which].includes(segment.state)).length
}

/**
 * The filter as a strip of tabs, since that is what it is: five views over one list, drawn the
 * way every other set of views in the application is drawn.
 *
 * Every state stays on the strip, including the ones nothing is in. A strip that grew a tab
 * whenever a piece failed would move the four beside it at the moment an operator most wants to
 * press one, and a count of zero says the state is empty without the tab having to disappear to
 * say it.
 */
function filterStrip(job: BuildJob): Strip<Filter>[] {
  return [
    { id: 'all', label: t('jobs.filterAll'), count: job.segments.length },
    ...CHIPS.map((chip) => ({
      id: chip.id as Filter,
      // The finished chip names the work — *Built*, *Cleared*, *Charted* — where the other three
      // are about the piece and read the same whatever is being done to it.
      label: chip.id === 'built' ? word(job, 'done') : t(chip.label),
      count: counted(job, chip.id),
    })),
  ]
}

function pieces(job: BuildJob): JobSegment[] {
  const chosen = filterOf(job)
  if (chosen === 'all') return job.segments
  return job.segments.filter((segment) => IN[chosen].includes(segment.state))
}

const mayRun = computed(() => auth.can('agent.run'))
const mayDelete = computed(() => auth.can('agent.delete'))

/**
 * Live jobs first, then the record of the ones that are over, each with its arithmetic done once.
 *
 * Paired rather than summarised in the template: a card reads its totals five times, and calling
 * the same function five times per render is the kind of thing that is fine until a fleet has forty
 * segments on screen.
 */
const cards = computed<Array<{ job: BuildJob; summary: JobSummary }>>(() =>
  [
    ...agentStore.jobs.filter((job) => job.state === 'ACTIVE'),
    ...agentStore.jobs.filter((job) => job.state !== 'ACTIVE'),
  ].map((job) => ({ job, summary: summarise(job) })),
)


/**
 * Who a *piece* of this job can be handed to: in game, on its server, holding nothing, and either
 * already on this job or on no job at all.
 *
 * **The crew counts.** Reading "not on a job" across every job including this one left the picker
 * empty on the ordinary case — every bot you own is already in this job’s pool — and it said
 * "nobody free on this server" while four of them stood idle in the crew tab. The backend has
 * always allowed it: pinning a piece onto a bot already working the build is the point.
 *
 * Holding a live piece is asked of everyone. One bot cannot place two segments, and the backend
 * answers 409 for it — offering it here would be the interface declining to know what it knows.
 */
function candidates(job: BuildJob): FleetAgent[] {
  return agentStore.agents.filter(
    (agent) =>
      isOnline(agent) &&
      agent.serverAddress === job.serverAddress &&
      !agentStore.workOf(agent.id) &&
      (agentStore.jobOf(agent.id)?.jobId ?? job.id) === job.id,
  )
}

/**
 * Who can be *added* to the crew, which is the narrower question: somebody already on this job
 * is not somebody to put on it.
 */
function newcomers(job: BuildJob): FleetAgent[] {
  return candidates(job).filter((agent) => agentStore.jobOf(agent.id) === null)
}

/**
 * One member of the crew, with what the job knows about it filled in.
 *
 * `agent` is looked up rather than carried: the pool row is a membership, and whether that bot is
 * in game right now is a fact about the fleet. It can be missing, because an agent deleted
 * mid-job leaves its label on the pieces it built.
 */
type Member = {
  member: JobAgent
  agent: FleetAgent | undefined
  /** The piece in its hands, or null — which is an ordinary state, not a stuck one. */
  holding: JobSegment | null
  built: number
}

function roster(job: BuildJob): Member[] {
  return job.pool.map((member) => ({
    member,
    agent: agentStore.agents.find((agent) => agent.id === member.agentId),
    holding:
      job.segments.find(
        (segment) =>
          segment.agentId === member.agentId &&
          (segment.state === 'ASSIGNED' || segment.state === 'BUILDING'),
      ) ?? null,
    built: job.segments.filter(
      (segment) => segment.agentId === member.agentId && segment.state === 'DONE',
    ).length,
  }))
}

/**
 * Blue for both states an agent can be holding a piece in.
 *
 * `ASSIGNED` and `BUILDING` are one thing to an operator scanning the table — somebody is on this.
 * They differ only in whether the host has said it started, which is a second or two apart and not
 * a distinction worth a colour. Green is for finished and red for refused, the two that end a piece.
 */
function segmentBadge(state: SegmentState, type: JobType): string {
  // Somebody is on it, in the colour of whatever they are doing. The two states differ only in
  // whether the host has said it started, which is a second or two apart.
  if (state === 'ASSIGNED' || state === 'BUILDING') return jobBadge(type)
  return { PENDING: 'badge-ghost', DONE: 'badge-success', FAILED: 'badge-error' }[state]
}

/** A bar takes the colour of the state it is reporting, so one piece reads the same everywhere. */
function segmentProgress(state: SegmentState, type: JobType): string {
  if (state === 'ASSIGNED' || state === 'BUILDING') return jobProgress(type)
  return { PENDING: '', DONE: 'progress-success', FAILED: 'progress-error' }[state]
}

/** Never past the end: a host that over-reports must not draw a bar wider than its own piece. */
function placed(segment: JobSegment): number {
  if (segment.blocks <= 0) return 0
  return Math.min(100, (segment.blocksPlaced / segment.blocks) * 100)
}

/** Running takes the colour of the work; stopped and finished are about the job, not the kind. */
function jobStateBadge(state: JobState, type: JobType): string {
  if (state === 'ACTIVE') return jobBadge(type)
  return { PAUSED: 'badge-warning', DONE: 'badge-success' }[state]
}

function box(segment: JobSegment): string {
  return `${segment.minX}, ${segment.minY}, ${segment.minZ} → ${segment.maxX}, ${segment.maxY}, ${segment.maxZ}`
}

/**
 * One wrapper for every action, because they differ only in what they call and what they say.
 *
 * The `finally` is the point: without it a refused action leaves the card's buttons disabled for
 * the rest of the session, which reads as the panel having broken rather than as the act having
 * been declined.
 */
async function act(jobId: number, call: () => Promise<unknown>, announce: string) {
  if (busy.value.has(jobId)) return
  busy.value = new Set(busy.value).add(jobId)
  try {
    await call()
    emit('done', announce)
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    const next = new Set(busy.value)
    next.delete(jobId)
    busy.value = next
  }
}

function stop(job: BuildJob) {
  return act(job.id, () => agentStore.stopJob(job.id), t('jobs.paused', { name: job.name }))
}

function restart(job: BuildJob) {
  return act(job.id, () => agentStore.restartJob(job.id), t('jobs.resumed', { name: job.name }))
}

/**
 * Asked first, like every other deletion in the application.
 *
 * This was the one destructive act that went straight from the click — and it is not a small one:
 * the segments go with the job, and with them every count of what the fleet actually placed. The
 * audit trail keeps that it happened; nothing keeps what was lost.
 */
const removing = ref<BuildJob | null>(null)
const removeDialog = ref<InstanceType<typeof ModalShell> | null>(null)

function askRemove(job: BuildJob) {
  removing.value = job
  removeDialog.value?.showModal()
}

function remove() {
  const job = removing.value
  if (!job) return

  removeDialog.value?.close()
  return act(job.id, () => agentStore.removeJob(job.id), t('jobs.removed', { name: job.name }))
}

function give(job: BuildJob, segment: JobSegment, event: Event) {
  const select = event.target as HTMLSelectElement
  const agentId = Number(select.value)
  // Back to the prompt either way: the row is about to be replaced by the answer, and a select
  // still showing a name while the cell says something else is two states at once.
  select.value = ''
  if (!agentId) return
  return act(
    job.id,
    () => agentStore.giveSegment(job.id, segment.id, agentId),
    t('jobs.assigned', { ordinal: segment.ordinal }),
  )
}

function take(job: BuildJob, segment: JobSegment) {
  return act(
    job.id,
    () => agentStore.freeSegment(job.id, segment.id),
    t('jobs.released', { ordinal: segment.ordinal }),
  )
}

/**
 * Puts agents on a job without saying which piece.
 *
 * Which piece each one gets depends on what is free and unblocked by the time it arrives, and that
 * is the scheduler's answer rather than an operator's — the reason this control names no segment.
 *
 * A dialog rather than the select it replaced, because the select could only offer the agents that
 * were already eligible: an operator looking for a bot that is right there in the fleet was told
 * nothing at all about why it was absent. The picker shows the rest greyed, with the reason.
 */
const dialogEl = ref<InstanceType<typeof ModalShell> | null>(null)
const pickingId = ref<number | null>(null)
const chosen = ref<number[]>([])

/** Looked up rather than held: the store replaces its jobs on every refresh. */
const picking = computed(() => agentStore.jobs.find((job) => job.id === pickingId.value) ?? null)

function invite(job: BuildJob) {
  pickingId.value = job.id
  chosen.value = []
  dialogEl.value?.showModal()
}

/**
 * On this server, and unpickable. Rendered greyed by the picker rather than left out, which is
 * what makes the dialog an answer to "why not that one" instead of a shorter list.
 *
 * Its own crew is neither: those agents are on the table behind the dialog.
 */
function unavailable(job: BuildJob): FleetAgent[] {
  const mine = new Set(job.pool.map((member) => member.agentId))
  return agentStore.agents.filter(
    (agent) =>
      agent.serverAddress === job.serverAddress &&
      !mine.has(agent.id) &&
      (!isOnline(agent) || agentStore.jobOf(agent.id) !== null),
  )
}

/**
 * One at a time on purpose: each join is its own request and the second must see what the first
 * did, or two agents can be handed the same free piece.
 */
function hire() {
  const job = picking.value
  if (!job || !chosen.value.length) return

  const ids = [...chosen.value]
  dialogEl.value?.close()
  return act(
    job.id,
    async () => {
      for (const agentId of ids) await agentStore.joinJob(job.id, agentId)
    },
    t('jobs.joined', { count: ids.length }, ids.length),
  )
}

function dismiss(job: BuildJob, agentId: number, label: string) {
  return act(job.id, () => agentStore.leavePool(job.id, agentId), t('jobs.left', { label }))
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-6 overflow-y-auto">
    <!-- The shape that is coming, like the tables and the dashboard: a word does not hold a page. -->
    <div v-if="!agentStore.loaded" class="flex flex-col gap-6">
      <div v-for="card in 2" :key="card" class="skeleton h-56 w-full"></div>
    </div>

    <p v-else-if="!cards.length" class="py-10 text-center text-sm opacity-50">{{ t('jobs.empty') }}</p>

    <!-- A job starting arrives on the stream, so a card appears with nobody having pressed. -->
    <TransitionGroup name="cards" tag="div" class="relative flex flex-col gap-6">
      <section
        v-for="{ job, summary } in cards"
        :key="job.id"
        class="card border-base-300 bg-base-200 border"
      >
      <div class="card-body gap-4">
        <!-- ─── What this job is ──────────────────────────────────────────── -->
        <header class="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div class="min-w-0 flex-1">
            <h3 class="card-title flex items-center gap-2 text-base">
              <!--
                The kind of work, twice over: an icon and, beside the state, the word. Colour alone
                is the one distinction some operators cannot make, and this is the line that says
                what the boxes on the map and the dots in the sidebar are coloured for.
              -->
              <component :is="JOB_ICON[job.type]" class="size-4" :style="jobStyle(job.type)" />
              {{ job.name }}
              <span class="badge badge-sm" :class="jobBadge(job.type)">
                {{ t(`jobType.${job.type}`) }}
              </span>
              <span class="badge badge-sm" :class="jobStateBadge(job.state, job.type)">
                {{
                  job.state === 'ACTIVE'
                    ? word(job, 'doing')
                    : job.state === 'DONE'
                      ? word(job, 'done')
                      : t('jobs.state.PAUSED')
                }}
              </span>
            </h3>
            <p class="mt-0.5 text-xs opacity-60">
              <!-- A region job has no file behind it, so there is nothing to name but the world. -->
              {{
                job.schematicName
                  ? t('jobs.subtitle', { schematic: job.schematicName, server: job.serverAddress })
                  : t('jobs.subtitleRegion', {
                      world: job.dimension ?? 'overworld',
                      server: job.serverAddress,
                    })
              }}
            </p>
            <p class="text-xs opacity-50">
              {{ t('jobs.startedBy', { who: job.createdBy, at: atShort(job.startedAt) }) }}
              ·
              {{ t('jobs.anchor', { x: job.placement.x, y: job.placement.y, z: job.placement.z }) }}
              <!--
                How a survey is being flown, said where the anchor is: the anchor alone is the
                height it was given, and that is a different instruction depending on this.
              -->
              <template v-if="job.type === 'MAP'">
                ·
                {{ job.rising ? t('jobs.rising') : t('jobs.level') }}
              </template>
            </p>
          </div>

          <button
            v-if="mayRun && job.state === 'ACTIVE'"
            type="button"
            class="btn btn-ghost btn-sm gap-2"
            :disabled="busy.has(job.id)"
            @click="stop(job)"
          >
            <Pause class="size-4" />
            {{ t('jobs.pause') }}
          </button>

          <button
            v-if="mayRun && job.state === 'PAUSED'"
            type="button"
            class="btn btn-primary btn-sm gap-2"
            :disabled="busy.has(job.id)"
            @click="restart(job)"
          >
            <Play class="size-4" />
            {{ t('jobs.resume') }}
          </button>

          <!--
            Only once it is over, matching what the backend will accept: cancelling and clearing
            away are two acts, one stops the fleet and the other throws the record of it out.

            Gone while the job runs, rather than shown and refused. A dead control is a worse answer
            than no control, and the cluster is right-aligned, so what is left simply moves over into
            the corner rather than leaving a hole where this was.
          -->
          <button
            v-if="mayDelete && job.state !== 'ACTIVE'"
            type="button"
            class="btn btn-ghost btn-sm text-error gap-2"
            :disabled="busy.has(job.id)"
            @click="askRemove(job)"
          >
            <Trash2 class="size-4" />
            {{ t('jobs.remove') }}
          </button>
        </header>

        <!-- ─── How far along ─────────────────────────────────────────────── -->
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between text-sm">
            <!-- What the number counts depends on the work: blocks laid, blocks taken out, or
                 columns of ground walked over. -->
            <span class="tabular-nums">
              {{ t(jobUnit(job.type), { placed: n(summary.placed), total: n(summary.total) }) }}
            </span>
            <span class="tabular-nums opacity-60">{{ summary.percent }}%</span>
          </div>
          <progress class="progress w-full" :class="jobProgress(job.type)" :value="summary.percent" max="100" />
          <!--
            One line, always. Both of these come and go as a job is paused and resumed, and a line
            that appears where there was none moves the table under it.

            The paused note is said where the consequence is felt: a paused job goes on holding its
            agents, so an operator wondering why a bot will not take other work finds it here.
          -->
          <p class="min-h-4 text-xs">
            <!--
              Said first, because it explains a bar that is not going to move: the pieces are cut and
              handed out, and no host yet knows what to do with one that is not a box of blocks.
            -->
            <span v-if="job.type !== 'BUILD' && job.state === 'ACTIVE'" class="opacity-60">
              {{ t('jobs.notDispatched') }}
            </span>
            <span v-else-if="job.state === 'ACTIVE' && summary.waiting.length" class="text-warning">
              {{ t('jobs.waiting', { count: summary.waiting.length }) }}
            </span>
            <span v-else-if="job.state === 'PAUSED'" class="opacity-60">
              {{ t('jobs.pausedNote') }}
            </span>
          </p>
        </div>

        <!--
          ─── The two lists ─────────────────────────────────────────────────

          The crew is not a column of the pieces table. An agent can be on the build holding nothing,
          waiting for the floor under its next piece to be finished, and reading the crew off the
          assignee column would have shown that agent nowhere at all. Counts on the tabs so the one
          that is not open still says how much is in it.
        -->
        <TabBar
          v-if="job.state !== 'DONE'"
          :model-value="view(job)"
          :tabs="strip(job)"
          @update:model-value="show(job, $event)"
        />

        <!-- ─── The pieces ────────────────────────────────────────────────── -->
        <div class="osmium-slide">
          <Transition :name="view(job) === 'pool' ? 'panel-next' : 'panel-prev'">
        <div v-if="view(job) === 'pieces'" class="flex flex-col gap-2">
          <!-- Past a handful: four rows do not need narrowing, and the strip would cost more room
               than it saves. -->
          <TabBar
            v-if="job.segments.length > 6"
            :model-value="filterOf(job)"
            :tabs="filterStrip(job)"
            variant="box"
            size="xs"
            @update:model-value="only(job, $event)"
          />

          <!--
            Capped and scrolled rather than allowed to run: a sixty-four piece job is one card, and
            three of them stacked put every control below the fold. `table-pin-rows` keeps the
            header in place, so a row read halfway down still has its columns named.

            A floor as well as a ceiling, because the height is what a filter changes: narrowing
            sixty rows to the two that failed collapsed the card and threw every card below it up
            the page. Between the two the table scrolls and nothing outside it moves.
          -->
          <div class="max-h-[30rem] min-h-48 overflow-auto">
            <!--
              **Fixed columns.** Every cell here changes what it holds without the row changing what
              it is: a picker becomes a name, a release button appears, a filter leaves only the
              rows that failed. Sized by content, each of those redrew every column in the table and
              the whole card jumped. The widths are declared once instead, and the last column keeps
              its room whether or not there is a button in it.
            -->
            <table class="table-pin-rows table table-fixed">
              <thead>
                <tr>
                  <!--
                    Wide enough for its own heading, not for its content. The cell holds an ordinal
                    and needs almost nothing; the word above it is *Segment*, and at `w-20` the
                    cell's own padding left about three characters of room — so the column that
                    says what the table is read as `Seg...`.
                  -->
                  <th class="w-28 truncate">{{ t('jobs.segment') }}</th>
                  <th class="w-28 truncate">{{ t('common.status') }}</th>
                  <th class="truncate">{{ t('jobs.box') }}</th>
                  <th class="w-56 truncate">{{ word(job, 'unit') }}</th>
                  <th class="w-52 truncate">{{ word(job, 'member') }}</th>
                  <th class="w-28"></th>
                </tr>
              </thead>
              <!--
                No transition here. A job is divided once and the pieces never change in number;
                what changes is which of them the filter is showing, and animating a re-list is
                sixty rows playing at once because somebody pressed `Built`.
              -->
              <tbody>
                <tr
                  v-for="segment in pieces(job)"
                  :key="segment.id"
                  class="hover:bg-base-300/40 transition-colors"
                >
                  <td class="tabular-nums opacity-70">{{ segment.ordinal }}</td>
                  <td>
                    <span class="badge badge-sm max-w-full" :class="segmentBadge(segment.state, job.type)">
                      {{ segmentStateLabel(segment.state, job) }}
                    </span>
                  </td>
                  <td class="truncate font-mono text-xs opacity-70">{{ box(segment) }}</td>
                  <!--
                    How far along this piece is, which used to be a panel on the dashboard listing
                    every segment of every job. It belongs beside the piece it describes: the
                    dashboard had to name the build for each row to mean anything, and an operator
                    reading one build had to go somewhere else to see it.
                  -->
                  <td>
                    <div class="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                      <span>{{ n(segment.blocksPlaced) }} / {{ n(segment.blocks) }}</span>
                      <span class="opacity-50">{{ segment.sharePercent }}%</span>
                    </div>
                    <progress
                      class="progress mt-1 w-full"
                      :class="segmentProgress(segment.state, job.type)"
                      :value="placed(segment)"
                      max="100"
                    ></progress>
                  </td>
                  <td>
                    <!-- A row is the same height whether it holds a name or a picker. -->
                    <div class="flex min-h-6 items-center">
                      <span v-if="segment.agentLabel" class="truncate">{{ segment.agentLabel }}</span>
                    <!--
                    A picker only where it can do something. A finished or cancelled job is a
                    record, and offering to reassign a piece of one would be offering an act the
                    backend refuses.
                  -->
                      <select
                        v-else-if="mayRun && job.state !== 'DONE'"
                        class="select select-xs w-full max-w-44"
                        :disabled="busy.has(job.id) || !candidates(job).length"
                        @change="give(job, segment, $event)"
                      >
                        <!--
                          Three reasons a piece is not being built, and they are not one sentence:
                          nothing is free, nothing *can* start because the floor under it is
                          unbuilt, or it is simply waiting to be given to somebody.
                        -->
                        <option value="">
                          {{
                            segment.blockedBy.length
                              ? t('jobs.assignBlocked')
                              : candidates(job).length
                                ? t('jobs.assignTo')
                                : t('jobs.nobodyAvailable')
                          }}
                        </option>
                        <option v-for="agent in candidates(job)" :key="agent.id" :value="agent.id">
                          {{ agent.label }}
                        </option>
                      </select>
                      <span v-else class="italic opacity-50">{{ t('jobs.unassigned') }}</span>
                    </div>

                    <!--
                      Said, not inferred. A piece nobody holds while agents stand idle reads as
                      stuck, and it is the ordinary case for anything cut on height: a bot is two
                      blocks tall and builds from the floor up, so a piece with unbuilt work under
                      it has nowhere for anybody to stand.
                    -->
                    <p v-if="segment.blockedBy.length" class="mt-0.5 text-xs opacity-60">
                      {{ t('jobs.blockedBy', { ordinals: segment.blockedBy.join(', ') }) }}
                    </p>

                    <!--
                      Said for the same reason as the line above it: a free piece that the idle agent
                      beside it will not pick up is an operator's decision, not a stuck scheduler.
                    -->
                    <p v-if="segment.releasedFrom" class="mt-0.5 text-xs opacity-60">
                      {{ t('jobs.releasedFrom', { label: segment.releasedFrom }) }}
                    </p>

                    <p v-if="segment.failureReason" class="text-error mt-0.5 text-xs">
                      {{ segment.failureReason }}
                    </p>
                  </td>
                  <td class="text-right">
                    <button
                      v-if="mayRun && job.state !== 'DONE' && segment.agentId !== null"
                      type="button"
                      class="btn btn-ghost btn-xs gap-1"
                      :disabled="busy.has(job.id)"
                      @click="take(job, segment)"
                    >
                      <Undo2 class="size-3.5" />
                      {{ t('jobs.release') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ─── Who is on it ──────────────────────────────────────────────── -->
        <div v-else class="flex flex-col gap-3">
          <div class="max-h-[30rem] min-h-48 overflow-auto">
            <table class="table-pin-rows table">
              <thead>
                <tr>
                  <th>{{ t('jobs.poolAgent') }}</th>
                  <th>{{ t('common.status') }}</th>
                  <th>{{ t('jobs.poolHolding') }}</th>
                  <th class="text-right">{{ word(job, 'done') }}</th>
                  <th>{{ t('jobs.poolSince') }}</th>
                  <th></th>
                </tr>
              </thead>
              <TransitionGroup name="rows" tag="tbody">
                <tr
                  v-for="row in roster(job)"
                  :key="row.member.agentLabel"
                  class="hover:bg-base-300/40 transition-colors"
                >
                  <td class="font-medium">{{ row.member.agentLabel }}</td>
                  <td>
                    <!--
                      The fleet's own badge, building substituted over online the way it is
                      everywhere else. A crew list that painted its own states would be the second
                      vocabulary for one fact.
                    -->
                    <span
                      v-if="row.agent"
                      class="badge badge-sm"
                      :class="agentBadge(row.agent.state, row.holding ? job.type : null)"
                    >
                      {{ agentStateLabel(row.agent.state, row.holding ? job.type : null) }}
                    </span>
                    <span v-else class="badge badge-sm badge-ghost">{{ t('jobs.poolGone') }}</span>
                  </td>
                  <td>
                    <span v-if="row.holding" class="tabular-nums">
                      {{ t('jobs.poolSegment', { ordinal: row.holding.ordinal }) }}
                    </span>
                    <!-- Idle is the ordinary state here, so it is worded as waiting rather than as
                         nothing: see the blocked line on the pieces table. -->
                    <span v-else class="text-xs italic opacity-50">{{ t('jobs.poolIdle') }}</span>
                  </td>
                  <td class="text-right tabular-nums">{{ n(row.built) }}</td>
                  <td class="text-xs whitespace-nowrap opacity-60">{{ atShort(row.member.joinedAt) }}</td>
                  <td class="text-right">
                    <button
                      v-if="mayRun && row.member.agentId !== null"
                      type="button"
                      class="btn btn-ghost btn-xs text-error gap-1"
                      :disabled="busy.has(job.id)"
                      :title="t('jobs.takeOff')"
                      @click="dismiss(job, row.member.agentId, row.member.agentLabel)"
                    >
                      <X class="size-3.5" />
                      {{ t('jobs.poolRemove') }}
                    </button>
                  </td>
                </tr>
                <tr v-if="!job.pool.length" key="nobody">
                  <td colspan="6">
                    <div class="flex flex-col items-center gap-2 py-10 opacity-60">
                      <Users class="size-6" />
                      <span class="text-sm">{{ t('jobs.poolEmpty') }}</span>
                    </div>
                  </td>
                </tr>
              </TransitionGroup>
            </table>
          </div>

          <!--
            Names no segment: which piece an agent gets depends on what is free and unblocked by the
            time it arrives, and that is the scheduler's answer rather than an operator's.
          -->
          <button
            v-if="mayRun"
            type="button"
            class="btn btn-primary btn-sm gap-2 self-start"
            :disabled="busy.has(job.id)"
            @click="invite(job)"
          >
            <UserPlus class="size-4" />
            {{ t('jobs.addAgent') }}
          </button>
        </div>
          </Transition>
        </div>
      </div>
      </section>
    </TransitionGroup>

    <!--
      Both dialogs are the page’s rather than each card’s: only one can be open at a time, and a
      card that carried its own would build a picker and a confirmation for every job on screen.
    -->
    <ModalShell
      ref="removeDialog"
      :title="t('jobs.removeTitle', { name: removing?.name })"
      :icon="Trash2"
      tone="error"
      @close="removing = null"
    >
      <p class="mt-3 text-sm opacity-70">{{ t('jobs.removeWarning') }}</p>
      <div class="modal-action">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          @click="removeDialog?.close()"
        >
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="btn btn-error btn-sm gap-2" @click="remove()">
          <Trash2 class="size-4" />
          {{ t('jobs.remove') }}
        </button>
      </div>
    </ModalShell>

    <ModalShell ref="dialogEl" :title="t('jobs.addAgent')" @close="pickingId = null">
      <p v-if="picking" class="mt-1 text-sm opacity-60">
        {{ t('jobs.addHint', { name: picking.name, server: picking.serverAddress }) }}
      </p>

      <div v-if="picking" class="mt-4">
        <AgentPicker
          v-model="chosen"
          :agents="newcomers(picking)"
          :unavailable="unavailable(picking)"
          :unavailable-note="t('jobs.pickerUnavailable')"
          bare
        />
      </div>

      <div class="modal-action">
        <form method="dialog">
          <button class="btn btn-ghost">{{ t('common.cancel') }}</button>
        </form>
        <button type="button" class="btn btn-primary" :disabled="!chosen.length" @click="hire()">
          {{ t('jobs.addSelected', { count: chosen.length }, chosen.length) }}
        </button>
      </div>
    </ModalShell>
  </div>
</template>
