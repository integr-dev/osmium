<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, TriangleAlert, X } from 'lucide-vue-next'
import ChatPanel from './ChatPanel.vue'
import { scopeKey, speakerCandidates, type ChatScope } from '../lib/chat'
import { useResizable } from '../lib/resizable'
import { useAgentStore } from '../stores/agents'
import { useChatStore } from '../stores/chat'

/**
 * Chat as a rail rather than a modal.
 *
 * It is the ambient texture of a live server and the only place a person talks to the fleet, and
 * behind two clicks it may as well not exist. So it sits alongside whatever page is open and stays
 * where it was put.
 *
 * The scope is chosen, not inferred from the route. Following the page would mean the rail rewrites
 * itself every time the operator navigates, which is the one thing an ambient panel must not do.
 */
const { t } = useI18n()
const agentStore = useAgentStore()
const chat = useChatStore()

/** Chat lines are long and the addresses are monospaced, so the useful width varies a lot by fleet. */
const { width, start, nudge } = useResizable({
  key: 'osmium.layout.chat',
  initial: 384,
  min: 300,
  max: 720,
  edge: 'left',
})

/**
 * What is actually shown: the chosen scope, or the first server until something is chosen. A rail
 * that opens empty and waits to be configured is a rail nobody opens twice.
 */
const scope = computed<ChatScope | null>(() => {
  if (chat.scope) return chat.scope
  const first = agentStore.serverSummaries[0]
  return first ? { kind: 'server', address: first.address } : null
})

/** Servers first, then agents: the server is the room and the agents are the people in it. */
const options = computed(() => ({
  servers: agentStore.serverSummaries,
  agents: agentStore.agents,
}))

const candidates = computed(() => (scope.value ? speakerCandidates(agentStore.agents, scope.value) : []))

/**
 * A server nobody is forwarding has no global feed at all, so what is on screen is whatever was
 * captured before the last listener left. Said outright rather than left as an empty panel, which
 * reads as a quiet server instead of a missing one.
 */
const listenerMissing = computed(() => {
  if (scope.value?.kind !== 'server') return false
  const address = scope.value.address
  return !agentStore.serverSummaries.find((server) => server.address === address)?.listener
})

/**
 * Who a message would be sent as. Held by id rather than by object, so it survives the fleet
 * refreshing underneath it, and falls back the moment that agent stops being a candidate — it going
 * offline is exactly when the choice stops being valid.
 */
const chosenSpeaker = ref<number | null>(null)

watch(
  () => (scope.value ? scopeKey(scope.value) : null),
  () => (chosenSpeaker.value = null),
)

const speaker = computed(
  () => candidates.value.find((agent) => agent.id === chosenSpeaker.value) ?? candidates.value[0] ?? null,
)

/** What the picker binds to, so it shows the fallback rather than sitting blank on top of one. */
const speakerId = computed({
  get: () => speaker.value?.id ?? null,
  set: (value: number | null) => (chosenSpeaker.value = value),
})

function choose(key: string): void {
  const [kind, ...rest] = key.split(':')
  const value = rest.join(':')
  chat.show(kind === 'agent' ? { kind: 'agent', id: Number(value) } : { kind: 'server', address: value })
}
</script>

<template>
  <!--
    In the flow beside the page on a wide screen, over it on a narrow one — a 384px column and a
    dashboard do not both fit on a laptop held sideways.
  -->
  <aside
    class="border-base-300 bg-base-200 fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l lg:relative lg:z-auto lg:h-full"
    :style="{ width: `${width}px` }"
  >
    <!-- The mirror of the sidebar's: dragging left widens a panel anchored to the right. -->
    <div
      class="hover:bg-primary/40 focus-visible:bg-primary/40 absolute inset-y-0 left-0 z-10 hidden w-1 cursor-col-resize outline-none lg:block"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('chat.resize')"
      tabindex="0"
      @pointerdown="start"
      @keydown.left.prevent="nudge(-16)"
      @keydown.right.prevent="nudge(16)"
    ></div>

    <div class="border-base-300 flex items-center gap-2 border-b px-3 py-3">
      <MessagesSquare class="text-primary size-4 shrink-0" />

      <select
        v-if="scope"
        class="select select-sm min-w-0 flex-1 font-mono text-xs"
        :aria-label="t('chat.scope')"
        :value="scopeKey(scope)"
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <!--
          The counts and the listener ride along here because this is now the only place they are
          shown. A server with nobody forwarding has no global feed at all, which is the one thing
          worth knowing before picking it.
        -->
        <optgroup :label="t('chat.servers')">
          <option v-for="server in options.servers" :key="server.address" :value="`server:${server.address}`">
            {{ server.address }} · {{ server.online }}/{{ server.total }} ·
            {{ server.listener ? t('chat.listening') : t('chat.notListening') }}
          </option>
        </optgroup>
        <optgroup :label="t('chat.agents')">
          <option v-for="agent in options.agents" :key="agent.id" :value="`agent:${agent.id}`">
            {{ agent.label }}
          </option>
        </optgroup>
      </select>

      <span v-else class="flex-1 text-sm font-medium">{{ t('chat.title') }}</span>

      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        :aria-label="t('common.close')"
        @click="chat.close()"
      >
        <X class="size-4" />
      </button>
    </div>

    <div v-if="scope" class="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <p v-if="listenerMissing" class="flex items-start gap-2 text-xs opacity-60">
        <TriangleAlert class="text-warning mt-0.5 size-3.5 shrink-0" />
        {{ t('chat.noListener') }}
      </p>

      <!--
        Speaking is impersonation through one agent, so a server scope has to name which. Shown even
        when there is only one, because "which of my bots just said that" is not a question the
        operator should have to work out afterwards.
      -->
      <label v-if="scope.kind === 'server' && candidates.length" class="flex items-center gap-2 text-xs opacity-60">
        {{ t('chat.speakAs') }}
        <select v-model="speakerId" class="select select-xs min-w-0 flex-1">
          <option v-for="agent in candidates" :key="agent.id" :value="agent.id">
            {{ agent.label }}{{ agent.chatListener ? ` · ${t('chat.listening')}` : '' }}
          </option>
        </select>
      </label>

      <ChatPanel :scope="scope" :speaker="speaker" />
    </div>

    <p v-else class="flex flex-1 items-center justify-center px-6 text-center text-sm opacity-50">
      {{ t('chat.noServers') }}
    </p>
  </aside>
</template>
