<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// Aliased: `Map` is a JavaScript built-in, and shadowing it is a trap for whoever needs one here.
import { Crosshair, Map as MapIcon, Navigation } from 'lucide-vue-next'

import WorldMap, { type Mark } from '../components/WorldMap.vue'
import { listMappedServers, type MapExtentResponse } from '../api/map'
import { useAgentStore } from '../stores/agents'
import { atShort } from '../lib/time'
import { parsePlace } from '../lib/mapCoords'

/**
 * Where the fleet is working, on the ground it has charted.
 *
 * The terrain comes from the map every agent fills in as it moves; the dots on top come from the
 * telemetry already arriving every second. Nothing here asks a host to do anything - unlike the 3D
 * viewer, this is only what has already been reported.
 *
 * Full bleed, with the controls floating over it as one panel. A map is read by looking at a lot of
 * it at once, and a header band above it spends a third of the screen saying what the screen is.
 *
 * A player who is not one of ours is drawn in the error colour, which is the one thing here worth
 * interrupting somebody for: a stranger walking onto a build is the question an operator opens a
 * map to answer.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const extents = ref<MapExtentResponse[]>([])
const server = ref<string | null>(null)
const world = ref<string | null>(null)
const map = ref<InstanceType<typeof WorldMap> | null>(null)

const typed = ref('')
const rejected = ref(false)

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
  world.value ??= newest?.dimension ?? null
})

/** The servers that have a map, each once, newest first - `extents` has a row per world. */
const servers = computed(() => [...new Set(extents.value.map((it) => it.serverAddress))])

/**
 * The worlds charted on the chosen server.
 *
 * Offered rather than assumed. What a server has is whatever agents have walked in, and on anything
 * running Multiverse that is not a list of three - it is however many worlds the operators made.
 */
const worlds = computed(() => extents.value.filter((it) => it.serverAddress === server.value))

const extent = computed(() => worlds.value.find((it) => it.dimension === world.value) ?? null)

/** The agents on the chosen server that have reported a position. */
const here = computed(() =>
  agentStore.agents.filter((agent) => agent.serverAddress === server.value && agent.telemetry),
)

/**
 * Which agents are standing in the world being drawn.
 *
 * An agent in the Nether is not on the Overworld map, and drawing its dot there puts it on ground it
 * has never seen. An agent whose host is too old to report a world is shown rather than hidden: a
 * dot in the wrong place is a smaller lie than a fleet that appears to be nowhere.
 */
const shown = computed(() =>
  here.value.filter((agent) => !agent.telemetry?.dimension || agent.telemetry.dimension === world.value),
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

/**
 * Goes to whatever was typed, or says it could not read it.
 *
 * The refusal is shown on the field rather than as a message, because there is only one thing it
 * can mean and the field is where the fix goes.
 */
function goToTyped(): void {
  const place = parsePlace(typed.value)
  rejected.value = !place
  if (!place) return

  map.value?.centreOn(place.x, place.z)
  typed.value = ''
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
watch([server, world], () => {
  placed.value = false
})

// Changing server may leave the chosen world naming one that server has never had.
watch(worlds, (available) => {
  if (available.length === 0) return
  if (!available.some((it) => it.dimension === world.value)) {
    world.value = available[0]!.dimension
  }
})

/**
 * What to call a world.
 *
 * The three vanilla ones get the names the game uses; everything else keeps the name the server
 * gave it. A Multiverse world is called whatever its operators called it, and that string is what
 * they type into `/mvtp` - rewriting it into something prettier would only make it harder to match
 * up with the server they are looking at.
 */
const VANILLA: Record<string, string> = {
  overworld: 'Overworld',
  the_nether: 'Nether',
  the_end: 'End',
}

function worldName(raw: string): string {
  return VANILLA[raw] ?? raw
}
</script>

<template>
  <div class="relative flex min-h-0 w-full flex-1 flex-col">
    <WorldMap
      v-if="server && world"
      ref="map"
      :server="server"
      :dimension="world"
      :marks="marks"
    />

    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <MapIcon class="size-8 opacity-20" />
      <p class="max-w-md text-sm opacity-50">{{ t('map.unmapped') }}</p>
    </div>

    <!--
      One panel, over the map rather than above it, built from the same card the rest of the app
      uses. Solid rather than ghost: a translucent control on terrain is whatever colour the terrain
      happens to be behind it, which is not readable.
    -->
    <div
      v-if="server"
      class="border-base-300 bg-base-200 absolute top-3 left-3 z-10 w-64 max-w-[calc(100%-1.5rem)] rounded-lg border shadow-md"
    >
      <div class="flex flex-col gap-3 p-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium opacity-60">{{ t('map.server') }}</span>
          <select v-model="server" class="select select-sm select-bordered w-full">
            <option v-for="option in servers" :key="option" :value="option">{{ option }}</option>
          </select>
        </label>

        <!--
          A dropdown rather than a row of buttons: a vanilla server has three worlds and anything
          running Multiverse has as many as its operators made, which is not a number a row of
          buttons can hold.
        -->
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium opacity-60">{{ t('map.world') }}</span>
          <select v-model="world" class="select select-sm select-bordered w-full">
            <option v-for="option in worlds" :key="option.dimension" :value="option.dimension">
              {{ worldName(option.dimension) }}
            </option>
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium opacity-60">{{ t('map.goto') }}</span>
          <div class="join w-full">
            <input
              v-model="typed"
              type="text"
              class="input input-sm input-bordered join-item w-full font-mono"
              :class="rejected ? 'input-error' : ''"
              :placeholder="t('map.gotoHint')"
              @input="rejected = false"
              @keyup.enter="goToTyped"
            />
            <button
              class="btn btn-sm btn-neutral join-item"
              :disabled="!typed.trim()"
              :aria-label="t('map.goto')"
              @click="goToTyped"
            >
              <Navigation class="size-3.5" />
            </button>
          </div>
        </label>

        <div v-if="extent" class="border-base-300 flex flex-col gap-0.5 border-t pt-2 text-xs opacity-60">
          <span>{{ t('map.charted', { count: extent.tiles }) }}</span>
          <span>{{ t('map.lastSeen', { when: atShort(extent.at) }) }}</span>
          <!--
            Said once, about the whole picture. Terrain is what an agent last walked past, which on
            a server people are building on may be hours old - and a map that does not say so reads
            as live.
          -->
          <span class="opacity-80">{{ t('map.stale') }}</span>
        </div>
      </div>
    </div>

    <!--
      The jump list. An operator with a dozen agents spread over a build cannot find them by panning,
      and the coordinates they would need are on another screen.
    -->
    <div
      v-if="shown.length"
      class="border-base-300 bg-base-200 absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-56 flex-col rounded-lg border shadow-md"
    >
      <div class="border-base-300 flex items-center justify-between gap-2 border-b px-3 py-2">
        <span class="text-xs font-medium">{{ t('map.agents') }}</span>
        <span class="badge badge-sm badge-ghost tabular-nums">{{ shown.length }}</span>
      </div>

      <div class="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
        <button class="btn btn-sm btn-ghost justify-start gap-2" @click="recentre">
          <Crosshair class="size-3.5 shrink-0 opacity-60" />
          <span class="truncate font-normal">{{ t('map.recentre') }}</span>
        </button>

        <button
          v-for="agent in shown"
          :key="agent.id"
          class="btn btn-sm btn-ghost justify-start gap-2 font-normal"
          @click="jumpTo(agent.id)"
        >
          <span class="bg-primary size-2 shrink-0 rounded-full" />
          <span class="truncate">{{ agent.label }}</span>
          <span class="ml-auto shrink-0 font-mono text-[0.65rem] tabular-nums opacity-50">
            {{ Math.round(agent.telemetry!.position.x) }}, {{ Math.round(agent.telemetry!.position.z) }}
          </span>
        </button>
      </div>

      <div class="border-base-300 flex items-center gap-3 border-t px-3 py-1.5 text-[0.7rem] opacity-60">
        <span class="flex items-center gap-1"><span class="bg-primary size-2 rounded-full" />{{ t('map.agents') }}</span>
        <span class="flex items-center gap-1"><span class="bg-error size-2 rounded-full" />{{ t('map.strangers') }}</span>
      </div>
    </div>
  </div>
</template>
