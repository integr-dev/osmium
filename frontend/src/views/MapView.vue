<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// Aliased: `Map` is a JavaScript built-in, and shadowing it is a trap for whoever needs one here.
import { Crosshair, Map as MapIcon } from 'lucide-vue-next'

import WorldMap, { type Mark } from '../components/WorldMap.vue'
import { listMappedServers, type MapExtentResponse } from '../api/map'
import { useAgentStore } from '../stores/agents'
import { atShort } from '../lib/time'

/**
 * Where the fleet is working, on the ground it has charted.
 *
 * The terrain comes from the map every agent fills in as it moves; the dots on top come from the
 * telemetry already arriving every second. Nothing here asks a host to do anything - unlike the 3D
 * viewer, this is only what has already been reported.
 *
 * Full bleed, with everything floating over the map. A map is read by looking at a lot of it at
 * once, and a card with a header above it spends a third of the screen saying what the screen is.
 *
 * A player who is not one of ours is drawn in the error colour, which is the one thing here worth
 * interrupting somebody for: a stranger walking onto a build is the question an operator opens a
 * map to answer.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const extents = ref<MapExtentResponse[]>([])
const server = ref<string | null>(null)
const dimension = ref<string | null>(null)
const map = ref<InstanceType<typeof WorldMap> | null>(null)
const panelOpen = ref(true)

/**
 * How many positions of an agent to remember.
 *
 * Telemetry arrives about once a second, so this is around half a minute of movement - long enough
 * to show which way somebody is heading, short enough that a trail is a trail rather than a
 * scribble over everywhere they have ever been.
 */
const TRAIL = 30

/** Recent positions per agent, appended as telemetry arrives. */
const trails = ref(new Map<number, Array<{ x: number; z: number }>>())

onMounted(async () => {
  extents.value = await listMappedServers()

  // Whichever world was charted most recently, which is where something is happening.
  const newest = extents.value[0]
  server.value ??= newest?.serverAddress ?? agentStore.servers[0] ?? null
  dimension.value ??= newest?.dimension ?? null
})

/** The servers that have a map, each once, newest first - `extents` has a row per world. */
const servers = computed(() => [...new Set(extents.value.map((it) => it.serverAddress))])

/**
 * The worlds charted on the chosen server.
 *
 * Offered rather than assumed: the dimensions a server has are whatever agents have walked in, and
 * a modded server's are not a list anything here could know in advance.
 */
const worlds = computed(() => extents.value.filter((it) => it.serverAddress === server.value))

const extent = computed(
  () => worlds.value.find((it) => it.dimension === dimension.value) ?? null,
)

/** The agents on the chosen server that have reported a position. */
const here = computed(() =>
  agentStore.agents.filter((agent) => agent.serverAddress === server.value && agent.telemetry),
)

/**
 * Which agents are standing in the world being drawn.
 *
 * An agent in the Nether is not on the Overworld map, and drawing its dot there puts it on ground
 * it has never seen. The dimension an agent reports is the same string a tile carries, so they
 * compare directly.
 */
const shown = computed(() =>
  here.value.filter((agent) => !agent.telemetry?.dimension || agent.telemetry.dimension === dimension.value),
)

/**
 * Everything drawn over the terrain: the fleet, and the people standing near it.
 *
 * A stranger is reported once per agent that can see them, so they are collapsed by name - two
 * agents watching the same person is one person. Ours are keyed by id, because two agents may
 * legitimately share a Minecraft name.
 */
const marks = computed<Mark[]>(() => {
  const found: Mark[] = []
  const strangers = new Map<string, Mark>()

  for (const agent of shown.value) {
    const telemetry = agent.telemetry
    if (!telemetry) continue

    found.push({
      id: `agent-${agent.id}`,
      label: agent.label,
      x: telemetry.position.x,
      z: telemetry.position.z,
      ours: true,
      trail: trails.value.get(agent.id) ?? [],
    })

    for (const player of telemetry.nearby) {
      if (player.isAgent || !player.position) continue
      strangers.set(player.name, {
        id: `player-${player.name}`,
        label: player.name,
        x: player.position.x,
        z: player.position.z,
        ours: false,
      })
    }
  }

  return [...found, ...strangers.values()]
})

/**
 * Appends to each trail as positions arrive.
 *
 * Only when the agent has actually moved: telemetry ticks whether or not anything changed, and a
 * standing agent would otherwise accumulate thirty copies of one point - which draws nothing and
 * throws away the history that was there.
 */
watch(
  here,
  (agents) => {
    const next = new Map(trails.value)
    for (const agent of agents) {
      const at = agent.telemetry?.position
      if (!at) continue

      const trail = next.get(agent.id) ?? []
      const last = trail[trail.length - 1]
      if (last && Math.abs(last.x - at.x) < 0.5 && Math.abs(last.z - at.z) < 0.5) continue

      next.set(agent.id, [...trail, { x: at.x, z: at.z }].slice(-TRAIL))
    }
    trails.value = next
  },
  { deep: true },
)

/** Puts the middle of the map on one agent. */
function jumpTo(agentId: number): void {
  const at = shown.value.find((agent) => agent.id === agentId)?.telemetry?.position
  if (at) map.value?.centreOn(at.x, at.z)
}

/** Puts the middle of the map on the middle of the fleet. */
function recentre(): void {
  const positions = shown.value.map((agent) => agent.telemetry!.position)
  if (positions.length === 0) return

  const x = positions.reduce((sum, at) => sum + at.x, 0) / positions.length
  const z = positions.reduce((sum, at) => sum + at.z, 0) / positions.length
  map.value?.centreOn(x, z)
}

// The first time the fleet reports where it is, go there - an operator opening the map wants the
// agents, not the origin. Only once: after that the view is theirs to move.
const placed = ref(false)
watch(shown, (agents) => {
  if (placed.value || agents.length === 0) return
  placed.value = true
  recentre()
})

// A different world is somewhere else entirely, so the view earns the right to jump again.
watch([server, dimension], () => {
  placed.value = false
})

// Changing server may leave the chosen world naming one that server has never had.
watch(worlds, (available) => {
  if (available.length === 0) return
  if (!available.some((it) => it.dimension === dimension.value)) {
    dimension.value = available[0]!.dimension
  }
})

/** `the_nether` reads as a database value; this is what the game calls it. */
function worldName(raw: string): string {
  return raw.replace(/^the_/, '').replaceAll('_', ' ')
}
</script>

<template>
  <div class="relative flex min-h-0 w-full flex-1 flex-col">
    <WorldMap
      v-if="server && dimension"
      ref="map"
      :server="server"
      :dimension="dimension"
      :marks="marks"
    />

    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <MapIcon class="size-8 opacity-20" />
      <p class="max-w-md text-sm opacity-50">{{ t('map.unmapped') }}</p>
    </div>

    <!--
      Over the map, not above it. Solid rather than ghost: a transparent control on terrain is
      whatever colour the terrain happens to be behind it, which is not readable.
    -->
    <div v-if="server" class="absolute top-3 left-3 z-10 flex max-w-[min(22rem,calc(100%-1.5rem))] flex-col gap-2">
      <div class="bg-base-200 flex items-center gap-2 rounded-lg p-2 shadow-md">
        <MapIcon class="size-4 shrink-0 opacity-40" />
        <select v-model="server" class="select select-xs select-ghost min-w-0 grow font-medium">
          <option v-for="option in servers" :key="option" :value="option">{{ option }}</option>
        </select>
      </div>

      <!-- One button per world rather than a second dropdown: there are three, and which one is
           being drawn is the single most misreadable thing on this screen. -->
      <div v-if="worlds.length > 1" class="bg-base-200 flex gap-1 rounded-lg p-1 shadow-md">
        <button
          v-for="world in worlds"
          :key="world.dimension"
          class="btn btn-xs grow capitalize"
          :class="world.dimension === dimension ? 'btn-primary' : 'btn-ghost'"
          @click="dimension = world.dimension"
        >
          {{ worldName(world.dimension) }}
        </button>
      </div>

      <div v-if="extent" class="bg-base-200/90 rounded-lg px-2 py-1.5 text-[0.7rem] leading-relaxed shadow-md">
        <div class="opacity-60">
          {{ t('map.charted', { count: extent.tiles }) }} · {{ t('map.lastSeen', { when: atShort(extent.at) }) }}
        </div>
        <!--
          Said once, about the whole picture. Terrain is what an agent last walked past, which on a
          server people are building on may be hours old - and a map that does not say so reads as
          live.
        -->
        <div class="opacity-50">{{ t('map.stale') }}</div>
      </div>
    </div>

    <!--
      The jump list. An operator with a dozen agents spread over a build cannot find them by panning,
      and the coordinates they would need are on another screen.
    -->
    <div
      v-if="shown.length"
      class="bg-base-200 absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-52 flex-col rounded-lg shadow-md"
    >
      <button
        class="hover:bg-base-300 flex items-center justify-between gap-2 rounded-t-lg px-3 py-2 text-xs font-medium"
        @click="panelOpen = !panelOpen"
      >
        <span>{{ t('map.agents') }} · {{ shown.length }}</span>
        <Crosshair class="size-3.5 opacity-40" />
      </button>

      <div v-if="panelOpen" class="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1 pt-0">
        <button class="btn btn-xs btn-ghost justify-start gap-2" @click="recentre">
          <span class="bg-primary size-2 shrink-0 rounded-full" />
          <span class="truncate">{{ t('map.recentre') }}</span>
        </button>

        <button
          v-for="agent in shown"
          :key="agent.id"
          class="btn btn-xs btn-ghost justify-start gap-2 font-normal"
          @click="jumpTo(agent.id)"
        >
          <span class="truncate">{{ agent.label }}</span>
          <span class="ml-auto shrink-0 font-mono text-[0.65rem] tabular-nums opacity-50">
            {{ Math.round(agent.telemetry!.position.x) }}, {{ Math.round(agent.telemetry!.position.z) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
