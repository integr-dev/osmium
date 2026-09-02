<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
// Aliased: `Map` is a JavaScript built-in, and shadowing it is a trap for whoever needs one here.
import { Crosshair, Map as MapIcon, Navigation } from 'lucide-vue-next'

import PlayerHead from '../components/PlayerHead.vue'
import WorldMap, { type Mark } from '../components/WorldMap.vue'
import { listMappedServers, type MapExtentResponse } from '../api/map'
import { useAgentStore } from '../stores/agents'
import { atShort } from '../lib/time'
import { parsePlace } from '../lib/mapCoords'
import { agentDot, agentStateLabel } from '../lib/agentState'
import { avatarUrl } from '../lib/avatars'
import { gamemodeLabel } from '../lib/vitals'

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
const route = useRoute()
const agentStore = useAgentStore()

/**
 * The agent the map was opened on, from `?agent=`.
 *
 * Its id rather than its coordinates: a link carrying a position is out of date the moment the
 * agent walks, and this one is followed from a page that was already watching it move. What the
 * link means is "show me where this is", which is a question only answerable when it is opened.
 */
const asked = computed(() => {
  const raw = route.query['agent']
  const id = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(id) ? agentStore.byId(id) : undefined
})

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

  // Where the link pointed, if it pointed anywhere. An agent names both the server and the world,
  // so following one lands on the map that actually holds it rather than on the busiest one.
  const wanted = asked.value
  if (wanted?.serverAddress) {
    server.value = wanted.serverAddress
    world.value = wanted.telemetry?.dimension ?? world.value
  }

  // Otherwise whichever world was charted most recently, which is where something is happening.
  const newest = extents.value[0]
  server.value ??= newest?.serverAddress ?? agentStore.servers[0] ?? null
  world.value ??= newest?.dimension ?? null
})

/**
 * The servers worth offering: any with a map, and any the fleet is standing on.
 *
 * A server nobody has charted yet still belongs here - an agent that just connected has a position
 * to show long before it has walked far enough to draw anything.
 */
const servers = computed(() => [
  ...new Set([
    ...extents.value.map((it) => it.serverAddress),
    ...agentStore.agents.flatMap((agent) => (agent.serverAddress ? [agent.serverAddress] : [])),
  ]),
])

/**
 * The worlds charted on the chosen server.
 *
 * Offered rather than assumed. What a server has is whatever agents have walked in, and on anything
 * running Multiverse that is not a list of three - it is however many worlds the operators made.
 */
const worlds = computed(() => {
  const charted = extents.value.filter((it) => it.serverAddress === server.value)
  const named = new Set(charted.map((it) => it.dimension))

  // Worlds the fleet is in but has not charted. Without these, following an agent into a world
  // nobody has walked yet lands on a picker that cannot name where it is - which is what a fresh
  // Multiverse world looks like the moment somebody teleports into it.
  const standing = agentStore.agents.flatMap((agent) =>
    agent.serverAddress === server.value && agent.telemetry?.dimension && !named.has(agent.telemetry.dimension)
      ? [agent.telemetry.dimension]
      : [],
  )

  return [
    ...charted,
    ...[...new Set(standing)].map((dimension) => ({
      serverAddress: server.value!,
      dimension,
      tiles: 0,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      at: new Date(0).toISOString(),
    })),
  ]
})

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

/** Somebody who is not one of ours, as the fleet between them can see them. */
interface Stranger {
  name: string
  x: number
  z: number
  /** How far the closest agent is, in blocks. */
  distance: number
  /** Which agent that is - the one to ask, and the one whose view this came from. */
  nearest: string
  /** Their account, which is what a head is actually drawn from. Null when unreported. */
  uuid: string | null
  /** Everything else the server said about them. Each is absent when it was not reported. */
  ping: number | null
  gamemode: number | null
}

/**
 * Everyone in view who is not one of ours, gathered from every agent at once.
 *
 * **Collapsed by name, keeping the closest sighting.** A player standing between two agents is
 * reported by both, and listing them twice would make a crowd out of one person - while the useful
 * reading, how near they are to anything of ours, is the smaller of the two distances.
 *
 * Sorted by that distance, because the order is the answer: whoever is closest to the fleet is
 * whoever an operator opened this screen about.
 */
const strangers = computed<Stranger[]>(() => {
  const found = new Map<string, Stranger>()

  for (const agent of shown.value) {
    for (const player of agent.telemetry?.nearby ?? []) {
      if (player.isAgent || !player.position) continue

      const held = found.get(player.name)
      if (held && held.distance <= player.distance) continue

      found.set(player.name, {
        name: player.name,
        x: player.position.x,
        z: player.position.z,
        distance: player.distance,
        nearest: agent.label,
        uuid: player.uuid,
        ping: player.ping,
        gamemode: player.gamemode,
      })
    }
  }

  return [...found.values()].sort((one, other) => one.distance - other.distance)
})

/**
 * What is worth saying about an agent besides its name.
 *
 * Health and food on the scale the game draws them, then the round trip. Each is dropped when it
 * was not reported rather than shown as a zero, which is a reading somebody would act on: an agent
 * that has not said how it is doing is not an agent on nought hearts.
 */
function agentVitals(agent: (typeof shown.value)[number]): string {
  const telemetry = agent.telemetry
  const parts: string[] = []

  if (typeof telemetry?.health === 'number') parts.push(t('map.hearts', { n: Math.round(telemetry.health) }))
  if (typeof telemetry?.food === 'number') parts.push(t('map.food', { n: Math.round(telemetry.food) }))
  if (typeof telemetry?.pingMs === 'number') parts.push(`${telemetry.pingMs}ms`)

  return parts.join(' · ')
}

/** The same for somebody who is not ours, which is less: a client is only told its own health. */
function strangerVitals(player: Stranger): string {
  const parts: string[] = []

  if (player.ping !== null) parts.push(`${player.ping}ms`)
  const mode = gamemodeLabel(player.gamemode)
  if (mode) parts.push(mode)

  return parts.join(' · ')
}

/**
 * What an agent is called in game, which is not what Osmium calls it.
 *
 * The label is the operator's name for it and the account is who other players see standing there,
 * so both belong on a screen about where things are: somebody reading chat, or looking at the
 * player list on the server, has only ever seen the second one.
 */
function agentDetail(agent: (typeof shown.value)[number]): string {
  return [agent.mcUsername, agentVitals(agent)].filter(Boolean).join(' · ')
}

/** Where something is, as F3 writes it and the coordinate box reads it back. */
function at(x: number, z: number): string {
  return `${Math.round(x)}, ${Math.round(z)}`
}

/**
 * Heads, by the account they belong to, for drawing onto the map.
 *
 * Fetched here rather than in the canvas because the request is Osmium's own avatar endpoint and
 * `avatarUrl` already holds the cache, the deduplication and the "this account has no head" answer.
 * What the canvas gets is a url it can hand to an `Image`.
 *
 * A face that has not arrived yet is simply absent, and the marker falls back to a plain dot until
 * it does - nothing waits on it.
 */
const faces = ref(new Map<string, string>())

function rememberFace(identifier: string | null | undefined): void {
  if (!identifier || faces.value.has(identifier)) return

  // Claimed before the request, so a second pass over the same marks does not ask twice while the
  // first is still in flight. Replaced with the real url, or dropped if there is no head.
  faces.value.set(identifier, '')
  void avatarUrl(identifier).then((url) => {
    if (!url) return
    faces.value = new Map(faces.value).set(identifier, url)
  })
}

/** The head for somebody, once it is there. */
function faceOf(identifier: string | null | undefined): string | undefined {
  const url = identifier ? faces.value.get(identifier) : undefined
  return url || undefined
}

// The two lists these come from, not the marks built out of them: the marks are declared below,
// and a watch is evaluated where it is written.
watch(
  [shown, strangers],
  ([agents, players]) => {
    for (const agent of agents) rememberFace(agent.mcUuid ?? agent.mcUsername)
    for (const player of players) rememberFace(player.uuid ?? player.name)
  },
  { immediate: true },
)

/**
 * Everything drawn over the terrain: the fleet, and the people standing near it.
 *
 * Ours are keyed by id, because two agents may legitimately share a Minecraft name.
 */
const marks = computed<Mark[]>(() => [
  ...shown.value.map((agent) => ({
    id: `agent-${agent.id}`,
    label: agent.label,
    x: agent.telemetry!.position.x,
    z: agent.telemetry!.position.z,
    ours: true,
    detail: agentDetail(agent),
    avatar: faceOf(agent.mcUuid ?? agent.mcUsername),
    // The same dot the sidebar puts on the same head, so one agent looks like one thing.
    dot: agentDot(agent.state, agentStore.isBuilding(agent.id)),
    trail: trails.value.get(agent.id) ?? [],
  })),
  ...strangers.value.map((player) => ({
    id: `player-${player.name}`,
    label: player.name,
    x: player.x,
    z: player.z,
    ours: false,
    detail: strangerVitals(player),
    avatar: faceOf(player.uuid ?? player.name),
  })),
])

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

/** The same, for somebody who is not one of ours. */
function jumpToPlace(x: number, z: number): void {
  map.value?.centreOn(x, z)
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

/**
 * Where to point the map when it opens.
 *
 * On the agent the link named, if it named one; otherwise on the middle of the fleet. Either way
 * only once - after that the view is the operator's to move, and a map that keeps pulling itself
 * back to where it started is one nobody can look away from.
 */
const placed = ref(false)
watch(
  [shown, asked],
  ([agents, wanted]) => {
    if (placed.value) return

    const at = wanted?.telemetry?.position
    if (at) {
      placed.value = true
      map.value?.centreOn(at.x, at.z)
      return
    }

    if (agents.length === 0) return
    placed.value = true
    recentre()
  },
  { immediate: true },
)

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
      class="border-base-300 bg-base-200 absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-lg border shadow-md"
    >
      <!-- One scroller over both lists: a crowded server makes the second one long, and a panel
           with two scrollbars in it is one nobody can find their place in. -->
      <div class="flex min-h-0 flex-col overflow-y-auto">
        <div class="bg-base-200 sticky top-0 flex items-center justify-between gap-2 px-3 pt-2 pb-1">
          <span class="flex items-center gap-1.5 text-xs font-medium">
            <span class="bg-primary size-2 rounded-full" />{{ t('map.agents') }}
          </span>
          <span class="badge badge-xs badge-ghost tabular-nums">{{ shown.length }}</span>
        </div>

        <div class="flex flex-col gap-0.5 px-2 pb-2">
          <button class="btn btn-sm btn-ghost justify-start gap-2" @click="recentre">
            <Crosshair class="size-3.5 shrink-0 opacity-60" />
            <span class="truncate font-normal">{{ t('map.recentre') }}</span>
          </button>

          <!--
            The row the sidebar and the agent picker both use: a head with its state on it, the name,
            and one muted line underneath. Three lists showing the same fleet in three shapes is
            three things to learn about one thing.
          -->
          <button
            v-for="agent in shown"
            :key="agent.id"
            class="btn btn-sm btn-ghost h-auto min-h-0 justify-start gap-2.5 py-1 font-normal"
            @click="jumpTo(agent.id)"
          >
            <span
              class="relative shrink-0"
              :title="agentStateLabel(agent.state, agentStore.isBuilding(agent.id))"
            >
              <PlayerHead :id="agent.mcUuid ?? agent.mcUsername" :name="agent.label" size="sm" />
              <span
                class="ring-base-200 absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
                :class="agentDot(agent.state, agentStore.isBuilding(agent.id))"
              />
            </span>
            <span class="min-w-0 flex-1 text-left">
              <!--
                Osmium's name for it, then Minecraft's. Both, because they are answers to different
                questions: the label is how an operator refers to this agent, and the account is who
                anybody reading chat or the server's player list has actually seen.
              -->
              <span class="block truncate text-xs">
                {{ agent.label }}
                <span v-if="agent.mcUsername" class="font-mono opacity-50">{{ agent.mcUsername }}</span>
                <span v-else class="italic opacity-50">{{ t('agents.notLinked') }}</span>
              </span>
              <span class="block truncate text-[0.65rem] tabular-nums opacity-50">
                <span class="font-mono">{{ at(agent.telemetry!.position.x, agent.telemetry!.position.z) }}</span>
                <template v-if="agentVitals(agent)">
                  <span class="opacity-60"> · </span>{{ agentVitals(agent) }}
                </template>
              </span>
            </span>
          </button>
        </div>

        <!--
          Below the fleet, because it is read against it: the question is who is near *ours*. Absent
          rather than empty when there is nobody - a heading over nothing reads as a list that failed
          to load, and "nobody is about" is better said by the map having no red on it.
        -->
        <template v-if="strangers.length">
          <div
            class="border-base-300 bg-base-200 sticky top-0 flex items-center justify-between gap-2 border-t px-3 pt-2 pb-1"
          >
            <span class="flex items-center gap-1.5 text-xs font-medium">
              <span class="bg-error size-2 rounded-full" />{{ t('map.strangers') }}
            </span>
            <span class="badge badge-xs badge-ghost tabular-nums">{{ strangers.length }}</span>
          </div>

          <div class="flex flex-col gap-0.5 px-2 pb-2">
            <button
              v-for="player in strangers"
              :key="player.name"
              class="btn btn-sm btn-ghost h-auto min-h-0 justify-start gap-2 py-1 font-normal"
              :title="t('map.seenBy', { agent: player.nearest })"
              @click="jumpToPlace(player.x, player.z)"
            >
              <PlayerHead :id="player.uuid ?? player.name" :name="player.name" size="sm" class="shrink-0" />
              <span class="min-w-0 flex-1 text-left">
                <span class="block truncate text-xs">{{ player.name }}</span>
                <!--
                  Where they are, then how far from the *nearest agent* - not from the middle of the
                  screen. That is the reading somebody acts on, and it is why the list is sorted by
                  it. Health is deliberately absent: a client is only ever told its own.
                -->
                <span class="block truncate text-[0.65rem] tabular-nums opacity-50">
                  <span class="font-mono">{{ at(player.x, player.z) }}</span>
                  <span class="opacity-60"> · </span>
                  {{ t('map.blocksAway', { count: Math.round(player.distance) }) }}
                  <template v-if="strangerVitals(player)">
                    <span class="opacity-60"> · </span>{{ strangerVitals(player) }}
                  </template>
                </span>
              </span>
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
