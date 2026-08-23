<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Hammer, Pause, Play, Trash2, Undo2 } from 'lucide-vue-next'
import type { BuildJob, JobSegment, JobState, SegmentState } from '../api/jobs'
import { summarise, type JobSummary } from '../lib/jobs'
import { isOnline, useAgentStore, type FleetAgent } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * Build jobs: what the fleet is actually working on.
 *
 * A job is a plan frozen — its own copy of the anchor and the rules — so nothing here reads the
 * build it came from. What is shown is what the agents were given, which is the only version that
 * describes the blocks going into the world.
 *
 * **Nothing is dispatched yet.** A segment is assigned and stays assigned: carrying one to a host
 * needs a wire message that does not exist. That is said on the panel rather than left for an
 * operator to infer from a progress bar that never moves.
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

/** Local time: an operator reading this is reasoning about their own working day. */
function when(at: string): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Who is free to take a piece: in game, on this job's server, and not holding one already.
 *
 * The last clause reads across every job, not this one. An agent building somewhere else is
 * unavailable here and the backend refuses it either way — offering it and answering 409 would be
 * the interface declining to know what it already knows.
 */
function candidates(job: BuildJob): FleetAgent[] {
  return agentStore.agents.filter(
    (agent) =>
      isOnline(agent) &&
      agent.serverAddress === job.serverAddress &&
      agentStore.assignmentOf(agent.id) === null,
  )
}

/**
 * Blue for both states an agent can be holding a piece in.
 *
 * `ASSIGNED` and `BUILDING` are one thing to an operator scanning the table — somebody is on this —
 * and they are today the same thing in fact, because nothing has been dispatched. Green is reserved
 * for finished and red for refused, which are the two that end a segment.
 */
const SEGMENT_BADGE: Record<SegmentState, string> = {
  PENDING: 'badge-ghost',
  ASSIGNED: 'badge-info',
  BUILDING: 'badge-info',
  DONE: 'badge-success',
  FAILED: 'badge-error',
}

const JOB_BADGE: Record<JobState, string> = {
  ACTIVE: 'badge-info',
  PAUSED: 'badge-warning',
  DONE: 'badge-success',
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
  return act(job.id, () => agentStore.stopJob(job.id), t('jobs.paused', { name: job.buildName }))
}

function restart(job: BuildJob) {
  return act(job.id, () => agentStore.restartJob(job.id), t('jobs.resumed', { name: job.buildName }))
}

function remove(job: BuildJob) {
  return act(job.id, () => agentStore.removeJob(job.id), t('jobs.removed', { name: job.buildName }))
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
</script>

<template>
  <div class="flex flex-col gap-6">
    <!--
      Said once, at the top, rather than as a caption under every stalled progress bar. A panel
      whose numbers cannot move yet should say so before an operator waits on them.
    -->
    <div role="status" class="alert alert-info alert-soft">
      <Hammer class="size-4" />
      <span>{{ t('jobs.awaitingHost') }}</span>
    </div>

    <p v-if="!agentStore.loaded" class="text-sm opacity-60">{{ t('common.loading') }}</p>

    <p v-else-if="!cards.length" class="text-sm opacity-60">{{ t('jobs.empty') }}</p>

    <template v-for="{ job, summary } in cards" :key="job.id">
      <section class="border-base-300 rounded-box flex flex-col gap-4 border p-4">
        <!-- ─── What this job is ──────────────────────────────────────────── -->
        <header class="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div class="min-w-0 flex-1">
            <h3 class="flex items-center gap-2 font-semibold">
              {{ job.buildName }}
              <span class="badge badge-sm" :class="JOB_BADGE[job.state]">
                {{ t(`jobs.state.${job.state}`) }}
              </span>
            </h3>
            <p class="mt-0.5 text-xs opacity-60">
              {{ t('jobs.subtitle', { schematic: job.schematicName, server: job.serverAddress }) }}
            </p>
            <p class="text-xs opacity-50">
              {{ t('jobs.startedBy', { who: job.createdBy, at: when(job.startedAt) }) }}
              ·
              {{ t('jobs.anchor', { x: job.placement.x, y: job.placement.y, z: job.placement.z }) }}
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
            Only once it is over, matching what the backend will accept. Cancelling and clearing
            away are two acts: one stops the fleet, the other throws the record of it out.
          -->
          <button
            v-if="mayDelete && job.state !== 'ACTIVE'"
            type="button"
            class="btn btn-ghost btn-sm text-error gap-2"
            :disabled="busy.has(job.id)"
            @click="remove(job)"
          >
            <Trash2 class="size-4" />
            {{ t('jobs.remove') }}
          </button>
        </header>

        <!-- ─── How far along ─────────────────────────────────────────────── -->
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between text-sm">
            <span class="tabular-nums">
              {{ t('jobs.placed', { placed: n(summary.placed), total: n(summary.total) }) }}
            </span>
            <span class="tabular-nums opacity-60">{{ summary.percent }}%</span>
          </div>
          <progress class="progress progress-info w-full" :value="summary.percent" max="100" />
          <p v-if="job.state === 'ACTIVE' && summary.waiting.length" class="text-warning text-xs">
            {{ t('jobs.waiting', { count: summary.waiting.length }) }}
          </p>
          <!--
            Said where the consequence is felt: a paused job goes on holding its agents, so an
            operator wondering why a bot will not take other work finds the answer on the job.
          -->
          <p v-else-if="job.state === 'PAUSED'" class="text-xs opacity-60">
            {{ t('jobs.pausedNote') }}
          </p>
        </div>

        <!-- ─── The pieces ────────────────────────────────────────────────── -->
        <div class="overflow-x-auto">
          <table class="table-sm table">
            <thead>
              <tr>
                <th>{{ t('jobs.segment') }}</th>
                <th>{{ t('common.status') }}</th>
                <th>{{ t('jobs.box') }}</th>
                <th class="text-right">{{ t('jobs.blocks') }}</th>
                <th>{{ t('jobs.assignee') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="segment in job.segments" :key="segment.id">
                <td class="tabular-nums opacity-70">{{ segment.ordinal }}</td>
                <td>
                  <span class="badge badge-sm" :class="SEGMENT_BADGE[segment.state]">
                    {{ t(`jobs.segmentState.${segment.state}`) }}
                  </span>
                </td>
                <td class="font-mono text-xs whitespace-nowrap opacity-70">{{ box(segment) }}</td>
                <td class="text-right tabular-nums">
                  {{ n(segment.blocks) }}
                  <span class="opacity-50">· {{ segment.sharePercent }}%</span>
                </td>
                <td>
                  <span v-if="segment.agentLabel">{{ segment.agentLabel }}</span>
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
                    <option value="">
                      {{ candidates(job).length ? t('jobs.assignTo') : t('jobs.nobodyAvailable') }}
                    </option>
                    <option v-for="agent in candidates(job)" :key="agent.id" :value="agent.id">
                      {{ agent.label }}
                    </option>
                  </select>
                  <span v-else class="italic opacity-50">{{ t('jobs.unassigned') }}</span>

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
                    <Undo2 class="size-3" />
                    {{ t('jobs.release') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
