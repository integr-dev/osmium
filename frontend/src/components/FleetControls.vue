<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, Power, Server } from 'lucide-vue-next'
import AgentPicker from './AgentPicker.vue'
import FormField from './FormField.vue'
import TabBar, { type Tab } from './TabBar.vue'
import { isOnline, useAgentStore, type FleetAgent } from '../stores/agents'

/**
 * The three things done to a group of agents at once: bring them into the game, take them out, and
 * point them at a Minecraft server.
 *
 * **One screen, because they are one act with a different verb.** They were two tabs, and the split
 * was by implementation rather than by intent — an operator setting up a group of bots does all
 * three in a row, and had to leave and come back for the middle one. Each shares the same shape:
 * pick agents, then say what happens to them.
 *
 * What the mode changes is which agents can be picked at all. Every one of these is refused by the
 * backend for the wrong agent — an online one cannot be reassigned, an offline one cannot be
 * disconnected — so the picker follows the verb and says why the rest are greyed.
 */
type Mode = 'connect' | 'disconnect' | 'server'

const { t } = useI18n()
const agentStore = useAgentStore()

const emit = defineEmits<{ done: [string]; failed: [string] }>()

const mode = ref<Mode>('connect')
const selected = ref<number[]>([])
const target = ref('')
const busy = ref(false)

/** How far through the run it is, so a long sequential loop is not one motionless word. */
const progress = ref<{ done: number; total: number } | null>(null)

const strip = computed<Tab<Mode>[]>(() => [
  { id: 'connect', label: t('operations.connect'), icon: Play },
  { id: 'disconnect', label: t('operations.disconnect'), icon: Power },
  { id: 'server', label: t('operations.serverMode'), icon: Server },
])

/**
 * An agent already on its way in cannot be connected again — the backend answers 409 — so it is
 * unavailable rather than selectable. Disconnect is unaffected: only a live session can end.
 */
function connectable(agent: FleetAgent): boolean {
  return !isOnline(agent) && agent.state !== 'CONNECTING'
}

function allowed(agent: FleetAgent): boolean {
  if (mode.value === 'disconnect') return isOnline(agent)
  if (mode.value === 'connect') return connectable(agent)
  // The address decides what the next connection targets, so a live one cannot be moved.
  return !isOnline(agent)
}

const eligible = computed(() => agentStore.agents.filter(allowed))
const blocked = computed(() => agentStore.agents.filter((agent) => !allowed(agent)))

const blockedNote = computed(() => {
  if (mode.value === 'disconnect') return t('operations.onlineOnly')
  if (mode.value === 'connect') return t('operations.offlineOnly')
  return t('operations.onlineExcluded')
})

/** Only what the current mode can actually act on, so a stale tick cannot be sent. */
const acting = computed(() =>
  selected.value.filter((id) => eligible.value.some((agent) => agent.id === id)),
)

const ready = computed(() => {
  if (!acting.value.length || busy.value) return false
  return mode.value === 'server' ? target.value.trim().length > 0 : true
})

/**
 * Says what it is about to do, and to how many.
 *
 * The button used to read `Connect` beside a mode control that also read `Connect`, which left the
 * count — the one number worth checking before doing something to twenty accounts at once — nowhere
 * on screen.
 */
const label = computed(() => {
  const count = acting.value.length
  if (busy.value && progress.value) {
    return t('operations.applyingOne', {
      done: progress.value.done + 1,
      total: progress.value.total,
    })
  }
  if (mode.value === 'connect') return t('operations.connectCount', { count }, count)
  if (mode.value === 'disconnect') return t('operations.disconnectCount', { count }, count)
  return t('operations.assignCount', { count }, count)
})

/** What went out, and what came back, for whichever verb is selected. */
async function act(id: number, address: string | null): Promise<void> {
  if (mode.value === 'connect') return agentStore.connect(id)
  if (mode.value === 'disconnect') return agentStore.disconnect(id)
  return agentStore.assignServer(id, address)
}

function reportDone(count: number, address: string | null): string {
  if (mode.value === 'connect') return t('operations.connected', { count })
  if (mode.value === 'disconnect') return t('operations.disconnected', { count })
  return address ? t('operations.assigned', { count, server: address }) : t('operations.cleared', { count })
}

function reportFailure(): string {
  if (mode.value === 'connect') return t('errors.connectAgent')
  if (mode.value === 'disconnect') return t('errors.disconnectAgent')
  return t('errors.assignServer')
}

async function run(clear = false) {
  const agents = acting.value
  if (!agents.length) return

  const address = mode.value === 'server' && !clear ? target.value.trim() : null
  if (mode.value === 'server' && !clear && !address) return

  busy.value = true
  progress.value = { done: 0, total: agents.length }

  // What actually happened, rather than what was asked for. A run that stops halfway is the
  // ordinary case here — one banned account, one full server — and reporting only the failure
  // left the operator not knowing whether the ones before it went through.
  const succeeded: number[] = []

  try {
    // One at a time. Each reaches a host and, for a connection, a real Minecraft server; twenty
    // simultaneous logins from one host is the shape of a thing that gets a host banned.
    for (const id of agents) {
      await act(id, address)
      succeeded.push(id)
      progress.value = { done: succeeded.length, total: agents.length }
    }
    emit('done', reportDone(agents.length, address))
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : reportFailure()
    const stopped = agentStore.byId(agents[succeeded.length])

    emit(
      'failed',
      succeeded.length
        ? t('operations.stoppedAfter', {
            count: succeeded.length,
            name: stopped?.label ?? '',
            reason,
          })
        : reason,
    )
  } finally {
    // Only the ones that went through, so pressing the button again does not redo them.
    selected.value = selected.value.filter((id) => !succeeded.includes(id))
    busy.value = false
    progress.value = null
  }
}
</script>

<template>
  <div class="grid h-full min-h-0 gap-6 overflow-y-auto lg:grid-cols-[20rem_1fr]">
    <AgentPicker
      v-model="selected"
      :agents="eligible"
      :unavailable="blocked"
      :unavailable-note="blockedNote"
      :title="t('operations.agents')"
    />

    <div class="card border-base-300 bg-base-200 h-fit border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <Server class="text-base-content/50 size-4" />
          {{ t('operations.fleetTitle') }}
        </h2>

        <!--
          The verb first, because it decides who can be picked. Choosing agents and then finding half
          of them ineligible is the version of this that wastes the operator's time.
        -->
        <TabBar v-model="mode" :tabs="strip" variant="box" />

        <p class="min-h-8 text-sm opacity-60">{{ t(`operations.hint_${mode}`) }}</p>

        <!-- Only the server mode asks for anything beyond a list of agents. -->
        <FormField
          v-if="mode === 'server'"
          v-model="target"
          :label="t('agents.server')"
          :icon="Server"
          :placeholder="t('agents.serverPlaceholder')"
          type="text"
        />

        <div class="border-base-300 flex flex-wrap items-center gap-3 border-t pt-4">
          <span v-if="!acting.length" class="text-xs opacity-50">
            {{ t('operations.pickAgents') }}
          </span>

          <!-- Its own act, not a mode: clearing an address is what un-assigns an agent. -->
          <button
            v-if="mode === 'server'"
            type="button"
            class="btn btn-ghost btn-sm ml-auto"
            :disabled="busy || !acting.length"
            @click="run(true)"
          >
            {{ t('operations.clearServer') }}
          </button>

          <button
            type="button"
            class="btn btn-primary btn-sm gap-2"
            :class="mode === 'server' ? '' : 'ml-auto'"
            :disabled="!ready"
            @click="run()"
          >
            <component :is="mode === 'disconnect' ? Power : mode === 'connect' ? Play : Server" class="size-4" />
            {{ label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
