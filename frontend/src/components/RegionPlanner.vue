<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Check, MapPin, Play, Plus, Save, Scissors, SquarePen, Trash2 } from 'lucide-vue-next'
import AgentPicker from './AgentPicker.vue'
import BoxViewer from './BoxViewer.vue'
import FormField from './FormField.vue'
import ModalShell from './ModalShell.vue'
import OrderPicker from './OrderPicker.vue'
import OrderPreview from './OrderPreview.vue'
import StepBar, { type Step as Bead } from './StepBar.vue'
import SwapBox from './SwapBox.vue'
import { useSlide } from '../lib/motion'
import { DEFAULT_ORDER, formatOrder, type PlacementOrder } from '../lib/placementOrder'
import { areaFromQuery, withoutArea } from '../lib/area'
import { WORLD_FLOOR, worldChoices, worldId } from '../lib/placement'
import { dimensionLabel } from '../lib/vitals'
import { JOB_ICON, jobStyle } from '../lib/jobKinds'
import { previewRegionSplit, type Region, type RegionType } from '../api/regions'
import type { SplitMode, SplitResponse } from '../api/schematics'
import type { Box as Box3d } from '../lib/box3d'
import { isOnline, useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * Working a region: digging a box of world out, or flying over one and charting it.
 *
 * **One component for both**, because they are one act with one number different. Both are a saved
 * box, a crew and a division; digging adds the height of the box and the order each piece is
 * worked in, and charting replaces the height with the one the agents fly at. Two components would
 * have been the same form twice, and the corner fields are the fiddly part.
 *
 * **The same four steps the build wizard has, asking the same questions in the same order**: what,
 * who, how it is divided, in what order. The first step is a plan — a region is saved and come
 * back to, exactly as a build plan is, because the same quarry is dug twice and retyping six
 * coordinates is the kind of thing that is right five times and wrong the sixth.
 *
 * Charting has one step fewer. What an order picks is the way a piece is swept, and a flight over
 * a rectangle has one sensible sweep; a step offering a choice that changes nothing is worse than
 * no step at all.
 */
const props = defineProps<{ kind: RegionType }>()

const emit = defineEmits<{ done: [string]; failed: [string]; started: [] }>()

const { t, n } = useI18n()
const route = useRoute()
const router = useRouter()
const agentStore = useAgentStore()
const auth = useAuthStore()

const digging = computed(() => props.kind === 'EXCAVATE')

/** The order step exists only where an order is a choice — see the note above. */
const steps = computed(() =>
  digging.value
    ? (['region', 'agents', 'split', 'order'] as const)
    : (['region', 'agents', 'split'] as const),
)

type Step = 'region' | 'agents' | 'split' | 'order'

const step = ref<Step>('region')

/** Which way the wizard was moved through, so a step arrives from the side its marker is on. */
const slide = useSlide(step, steps.value as readonly Step[])

/** The labels never carry their own number: the circle on the line is where the number lives. */
const beads = computed<Bead<Step>[]>(() =>
  // The build wizard's own vocabulary. The steps after the first ask exactly what its steps ask,
  // and two names for one step is two things to learn.
  steps.value.map((name) => ({
    id: name,
    label: name === 'region' ? t('region.step_region') : t(`schematics.step_${name}`),
  })),
)

// ---- the plan ----------------------------------------------------------------------------------

/** Only this tab's kind: an excavation and a survey are two different acts on two different lists. */
const mine = computed(() => agentStore.regions.filter((region) => region.type === props.kind))

/** Which one is being worked on, or null while a new one is being written. */
const selectedId = ref<number | null>(null)

const selected = computed<Region | null>(
  () => mine.value.find((region) => region.id === selectedId.value) ?? null,
)

const name = ref('')
const wantedServer = ref('')
const dimension = ref('')

/**
 * Two opposite corners, as typed. Inclusive, either way round — the backend sorts them too.
 *
 * **Empty to begin with, and a region can be saved that way**, as a build plan can be saved
 * unplaced: deciding to dig somewhere comes before going out to read the coordinates. What an
 * unplaced region cannot do is be started, which is refused at the start rather than here.
 */
type Axis = 'x' | 'y' | 'z'
type Corners = Record<Axis, number | null>

const from = ref<Corners>({ x: null, y: null, z: null })
const to = ref<Corners>({ x: null, y: null, z: null })

/** Where the agents fly while charting. Only ever read in the MAP case. */
const height = ref<number | null>(null)

/**
 * Whether the crew climbs over what is in the way instead of holding one height.
 *
 * A flat flight is only flat where the ground is: charting a valley at the height of its rim
 * wastes the flight, and charting it at the height of its floor flies agents into the hillside.
 * Rising, {@link height} is the lowest they go rather than the only height they fly.
 */
const rising = ref(false)

/**
 * Turning the climb on fills the height in, when nothing has been typed there.
 *
 * The floor of the world is the honest default for a flight that rises over what it meets: it
 * starts under the terrain and follows it up, which is what was asked for. A number somebody has
 * already typed is theirs and is left alone, and turning the climb off leaves it where it is.
 */
watch(rising, (climbing) => {
  if (!climbing || Number.isFinite(height.value as number)) return
  height.value = WORLD_FLOOR[dimension.value as keyof typeof WORLD_FLOOR] ?? WORLD_FLOOR.overworld
})

const saving = ref(false)

/** What the last save came to, said beside the button rather than as a banner over the page. */
const saved = ref<string | null>(null)

/**
 * The axes a corner is typed on: all three for a box, two for a footprint.
 *
 * A survey's Y is the height its agents fly, which is a field of its own further down — a Y on each
 * corner would be the same number asked for twice and read neither time.
 */
const axes = computed<Array<'x' | 'y' | 'z'>>(() => (digging.value ? ['x', 'y', 'z'] : ['x', 'z']))

/**
 * A corner once every axis this kind needs has an actual number in it.
 *
 * Tested for being a finite number rather than for not being null: a cleared `<input type=number>`
 * hands `v-model.number` back the **empty string**, which is not null — the same trap the build
 * planner's placement fell into.
 */
function typed(corner: Corners): { x: number; y: number; z: number } | null {
  const filled = axes.value.every((axis) => Number.isFinite(corner[axis] as number))
  if (!filled) return null
  // A survey's Y is the flying height, checked separately; anything is fine here.
  return { x: corner.x as number, y: (corner.y as number) ?? 0, z: corner.z as number }
}

/** The box those corners describe, half-open and sorted, or null while it is unmeasured. */
const box = computed(() => {
  const near = typed(from.value)
  const far = typed(to.value)
  if (!near || !far) return null

  const flying = height.value
  if (!digging.value && !Number.isFinite(flying as number)) return null

  const low = digging.value ? Math.min(near.y, far.y) : (flying as number)
  const high = digging.value ? Math.max(near.y, far.y) + 1 : (flying as number) + 1

  return {
    west: Math.min(near.x, far.x),
    east: Math.max(near.x, far.x) + 1,
    north: Math.min(near.z, far.z),
    south: Math.max(near.z, far.z) + 1,
    low,
    high,
  }
})

const size = computed(() => {
  const at = box.value
  if (!at) return null
  return { x: at.east - at.west, y: at.high - at.low, z: at.south - at.north }
})

/** Blocks for a dig, columns of ground for a survey — the slab being one block thick. */
const volume = computed(() => (size.value ? size.value.x * size.value.y * size.value.z : 0))

/** Matching `RegionService.MAX_REGION_BLOCKS`, so the form refuses what the backend would. */
const MAX_BLOCKS = 16_000_000

/** Matching `SchematicService.MAX_PARTS`, as the build wizard's field does. */
const MAX_PARTS = 64

/** The addresses agents actually report, so a choice here can never miss by a character. */
const servers = computed(() => {
  const known = new Set(
    agentStore.agents
      .map((agent) => agent.serverAddress)
      .filter((address): address is string => !!address),
  )
  // The plan's own, in case every agent that was on it has since gone somewhere else.
  if (wantedServer.value) known.add(wantedServer.value)
  return [...known].sort()
})

/**
 * The worlds worth offering for the chosen server, by the same rule the map picks its own: the
 * three every server has, plus whatever the fleet is standing in, plus the plan's own.
 *
 * A server running Multiverse has as many worlds as its operators made, and a box typed against
 * one of them belongs to that world and no other.
 */
const dimensions = computed(() =>
  worldChoices(agentStore.worldsOn(wantedServer.value), dimension.value),
)

/**
 * What is wrong with the corners, or nothing.
 *
 * Nothing when there are none: an unplaced region is a plan somebody has not been out to measure,
 * not a mistake. It is the *start* that refuses it.
 */
const boxFault = computed<string | null>(() => {
  if (!box.value) return null
  if (volume.value <= 0) return t('region.needBox')
  if (volume.value > MAX_BLOCKS) return t('region.tooBig', { max: n(MAX_BLOCKS) })
  return null
})

/** What is missing before this can be saved at all, which is only ever the name. */
const unsavable = computed<string | null>(() => {
  if (!name.value.trim()) return t('region.needName')
  return boxFault.value
})

/** Whether the fields differ from the plan they were loaded from. */
const dirty = computed(() => {
  const region = selected.value
  if (!region) return true

  const at = box.value
  const placedTheSame = at
    ? region.placement?.x === at.west &&
      region.placement?.y === at.low &&
      region.placement?.z === at.north &&
      region.regionMax?.x === at.east &&
      region.regionMax?.y === at.high &&
      region.regionMax?.z === at.south
    : region.placement === null

  return (
    region.name !== name.value.trim() ||
    (region.serverAddress ?? '') !== wantedServer.value ||
    (region.dimension ?? '') !== dimension.value ||
    region.rising !== rising.value ||
    !placedTheSame
  )
})

/** Loads a plan into the fields, or clears them for a new one. */
function choose(id: number | null): void {
  selectedId.value = id
  saved.value = null
  const region = id === null ? null : mine.value.find((candidate) => candidate.id === id)

  if (!region) {
    name.value = nextName()
    wantedServer.value = ''
    dimension.value = ''
    from.value = { x: null, y: null, z: null }
    to.value = { x: null, y: null, z: null }
    height.value = null
    rising.value = false
    return
  }

  name.value = region.name
  wantedServer.value = region.serverAddress ?? ''
  dimension.value = region.dimension ?? ''
  // Back to the inclusive corners an operator typed: the far one is stored exclusive.
  from.value = region.placement
    ? { x: region.placement.x, y: region.placement.y, z: region.placement.z }
    : { x: null, y: null, z: null }
  to.value = region.regionMax
    ? { x: region.regionMax.x - 1, y: region.regionMax.y - 1, z: region.regionMax.z - 1 }
    : { x: null, y: null, z: null }
  height.value = region.placement?.y ?? null
  rising.value = region.rising
}

/**
 * What a new region is called before anybody renames it: its kind, numbered when that is taken.
 *
 * The build planner's rule, for the build planner's reason — a plan has to be called something the
 * moment it exists, and asking for a name before the operator has decided the thing is worth
 * keeping is a field in the way of the six that matter. Renaming is theirs.
 */
function nextName(): string {
  const stem = t(`region.${props.kind}.untitled`)
  const used = new Set(mine.value.map((region) => region.name))
  if (!used.has(stem)) return stem

  let suffix = 2
  while (used.has(`${stem} ${suffix}`)) suffix += 1
  return `${stem} ${suffix}`
}

/** Renaming, which is its own act: the card writes coordinates, and this writes the name. */
const renameDialog = ref<InstanceType<typeof ModalShell> | null>(null)
const nameDraft = ref('')

/** One flag for both dialogs, as the build planner has: only one of them is ever open. */
const busy = ref(false)

function openRename(): void {
  if (!selected.value) return
  nameDraft.value = selected.value.name
  renameDialog.value?.showModal()
}

async function saveName(): Promise<void> {
  const region = selected.value
  if (!region || busy.value || !nameDraft.value.trim()) return

  busy.value = true
  try {
    const renamed = await agentStore.editRegion(region.id, { name: nameDraft.value.trim() })
    name.value = renamed.name
    renameDialog.value?.close()
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  if (unsavable.value) return
  saving.value = true
  try {
    const at = box.value
    // Sent as the inclusive corners the backend expects, from the box rather than the fields: it
    // has already sorted them and worked out a survey's flying height.
    const corners = at
      ? {
          from: { x: at.west, y: at.low, z: at.north },
          to: { x: at.east - 1, y: at.high - 1, z: at.south - 1 },
        }
      : {}

    // Blank rather than omitted: blank is how the API is told to take a server or a world back
    // off a plan, and omitting them would leave whatever was there.
    const body = {
      name: name.value.trim(),
      ...corners,
      serverAddress: wantedServer.value,
      dimension: dimension.value,
      // Only a survey flies, and the backend ignores it on anything else; said once, here.
      rising: !digging.value && rising.value,
    }

    const region = selected.value
      ? await agentStore.editRegion(selected.value.id, { ...body, unplace: !at })
      : await agentStore.saveRegion({ ...body, type: props.kind })

    selectedId.value = region.id
    // A division belongs to the box it was cut from, and the box may have just moved.
    split.value = null
    saved.value = t('region.saved', { name: region.name })
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    saving.value = false
  }
}

const removeDialog = ref<InstanceType<typeof ModalShell> | null>(null)

async function remove(): Promise<void> {
  const region = selected.value
  if (!region || busy.value) return

  busy.value = true
  try {
    await agentStore.removeRegion(region.id)
    emit('done', t('region.removed', { name: region.name }))
    removeDialog.value?.close()
    choose(mine.value[0]?.id ?? null)
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    busy.value = false
  }
}

// ---- the crew ----------------------------------------------------------------------------------

const crew = ref<number[]>([])
const wantedParts = ref<number | null>(null)
const mode = ref<SplitMode>('COLUMNS')
const order = ref<PlacementOrder>(DEFAULT_ORDER)
const starting = ref(false)

/**
 * Digging starts at the roof, which is the one thing about it that is not building in reverse by
 * accident: a bot that begins at the floor of a hole is standing under everything it has left to
 * take out. The same default the backend applies when nobody says.
 */
const DIGGING_ORDER: PlacementOrder = {
  ...DEFAULT_ORDER,
  sweeps: [
    { axis: 'y', towards: -1 },
    { axis: 'z', towards: 1 },
    { axis: 'x', towards: 1 },
  ],
}

/**
 * An area dragged out on the 2D map, arriving as a new plan with its corners already in it.
 *
 * **The map is where the stretch is actually chosen.** Everywhere else these six numbers are read
 * off a screen and typed in again, which is where a survey of the wrong valley comes from, so the
 * map hands them over rather than saying them — see `areaQuery`.
 *
 * A new plan and not a saved one: arriving with a form filled in is a suggestion, and it is saved
 * when the operator says so, exactly as a survey typed by hand is. The flying height is the one
 * thing left blank, because a map drawn from above has no height to give.
 *
 * Nothing is taken from the query while digging: an excavation wants two heights the map cannot
 * supply, and half a box is not a head start.
 */
function handedOver(): boolean {
  if (digging.value) return false

  const handed = areaFromQuery(route.query)
  if (!handed) return false

  choose(null)
  wantedServer.value = handed.server
  // As agents spell it, which is what the picker offers: the map carries both spellings, and two
  // names for one world is how a box ends up drawn on no map at all.
  dimension.value = worldId(handed.dimension)
  from.value = { x: handed.area.west, y: null, z: handed.area.north }
  to.value = { x: handed.area.east, y: null, z: handed.area.south }

  void router.replace({ query: withoutArea(route.query) })
  return true
}

onMounted(async () => {
  if (digging.value) order.value = DIGGING_ORDER
  if (!agentStore.agents.length) await agentStore.refresh()
  else if (!agentStore.regions.length) await agentStore.loadRegions()
  if (!handedOver()) choose(mine.value[0]?.id ?? null)
})

const parts = computed(() => wantedParts.value ?? crew.value.length)

/**
 * Who can be sent: in game, on no other job, and on **the plan's** server.
 *
 * Where a build job takes its target from its crew, a region says which world its coordinates were
 * read in — so the plan narrows the list rather than the first tick doing it. A box typed against
 * one world's landscape must not be dug in another because somebody chose a different agent.
 */
const eligible = computed(() =>
  agentStore.agents.filter(
    (agent) =>
      isOnline(agent) &&
      agentStore.jobOf(agent.id) === null &&
      agent.serverAddress !== null &&
      agent.serverAddress === selected.value?.serverAddress,
  ),
)

const blocked = computed(() => agentStore.agents.filter((agent) => !eligible.value.includes(agent)))

/** Everything a job needs that a plan is allowed to leave open. Null when it is all there. */
const unstartable = computed<string | null>(() => {
  const region = selected.value
  if (!region || dirty.value) return t('region.needSaved')
  if (!region.placement) return t('region.needCorners')
  if (!region.serverAddress || !region.dimension) return t('jobs.needWorld')
  return null
})

/**
 * The box as the viewer draws one, so the corners typed can be looked at before anybody flies.
 *
 * Unlabelled, deliberately. There is one box on this screen and the card beside it is already
 * titled with its name; writing that name into a corner of the drawing as well says nothing the
 * operator did not just type, and gets in the way of the coordinates that do. The pieces of a
 * division carry labels, because there the number is the only thing telling them apart.
 */
const boxes = computed<Box3d[]>(() => {
  const at = box.value
  if (!at) return []
  return [
    {
      id: 'region',
      min: { x: at.west, y: at.low, z: at.north },
      max: { x: at.east, y: at.high, z: at.south },
    },
  ]
})

// ---- the division ------------------------------------------------------------------------------

/**
 * The division, once it has been asked for.
 *
 * **Asked of the backend rather than worked out here**, exactly as the build wizard asks for a
 * schematic's split: the pieces drawn have to be the pieces dispatched, and two implementations of
 * the same halving is how that stops being true.
 */
const split = ref<SplitResponse | null>(null)
const splitting = ref(false)

async function runSplit(): Promise<void> {
  const region = selected.value
  if (!region || !parts.value) return
  splitting.value = true
  try {
    split.value = await previewRegionSplit(region.id, {
      // A slab one block thick has no height to cut, so charting is always strips.
      mode: digging.value ? mode.value : 'COLUMNS',
      parts: parts.value,
    })
  } catch (failure) {
    split.value = null
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    splitting.value = false
  }
}

/** The pieces as boxes, drawn in place of the whole region once there is a division to show. */
const splitBoxes = computed<Box3d[] | null>(() => {
  const segments = split.value?.segments
  if (!segments?.length) return null

  return segments.map((segment) => ({
    id: `segment-${segment.ordinal}`,
    label: String(segment.ordinal),
    blocks: segment.blocks,
    min: { x: segment.minX, y: segment.minY, z: segment.minZ },
    max: { x: segment.maxX, y: segment.maxY, z: segment.maxZ },
  }))
})

// A division belongs to one plan, one mode and one number of pieces. Left on screen after any of
// them changes it is a picture of something nobody asked for.
watch([selectedId, mode, parts], () => {
  split.value = null
})

// The confirmation is about a particular set of values, so the moment they move again it is no
// longer true. Anything else leaves "Saved" sitting under a region that has since been edited.
watch(dirty, (changed) => {
  if (changed) saved.value = null
})

// A crew from another server is not this plan's crew: switching plans takes the ticks with it.
watch(
  () => selected.value?.serverAddress,
  () => {
    crew.value = crew.value.filter((id) =>
      eligible.value.some((agent) => agent.id === id),
    )
  },
)

// ---- moving between the steps -------------------------------------------------------------------

/**
 * Whether this step has been answered.
 *
 * Forwards only past a step that has been: a step reached without its answer is a panel that
 * cannot do anything, which reads as the screen being broken.
 */
const canAdvance = computed(() =>
  step.value === 'region'
    ? unstartable.value === null
    : step.value === 'agents'
      ? crew.value.length > 0
      : step.value === 'split'
        ? split.value !== null
        : false,
)

/** What is missing, said rather than only refused. */
const missing = computed<string | null>(() =>
  step.value === 'region'
    ? (unsavable.value ?? unstartable.value)
    : step.value === 'agents'
      ? t('schematics.needBuilders')
      : step.value === 'split'
        ? t('schematics.needSplit')
        : null,
)

/** The last step's button has its own preconditions, which are every step's at once. */
const blocking = computed<string | null>(() => {
  if (unstartable.value) return unstartable.value
  if (!crew.value.length) return t('schematics.needBuilders')
  if (!split.value) return t('schematics.needSplit')
  if (!auth.can('agent.run')) return t('region.needPermission')
  return null
})

function go(to: Step) {
  const list = steps.value as readonly Step[]
  const target = list.indexOf(to)
  const here = list.indexOf(step.value)
  if (target > here && !canAdvance.value) return
  step.value = to
}

function next() {
  const list = steps.value as readonly Step[]
  const at = list.indexOf(step.value)
  if (at < list.length - 1 && canAdvance.value) step.value = list[at + 1]!
}

function back() {
  const list = steps.value as readonly Step[]
  const at = list.indexOf(step.value)
  if (at > 0) step.value = list[at - 1]!
}

/** Whichever step ends the wizard: the order for a dig, the division for a survey. */
const last = computed(() => step.value === steps.value[steps.value.length - 1])

async function start(): Promise<void> {
  const region = selected.value
  if (!region || blocking.value) return
  starting.value = true
  try {
    const job = await agentStore.beginRegionJob(region.id, {
      mode: digging.value ? mode.value : 'COLUMNS',
      agentIds: [...crew.value],
      ...(wantedParts.value ? { parts: wantedParts.value } : {}),
      ...(digging.value ? { order: formatOrder(order.value) } : {}),
    })

    emit('done', t(`region.${props.kind}.started`, { name: job.name, count: job.segments.length }))
    emit('started')
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-6">
    <StepBar :steps="beads" :current="step" clickable @select="go" />

    <SwapBox>
      <Transition :name="slide">
        <!-- ─── The plan ────────────────────────────────────────────────────── -->
        <div v-if="step === 'region'" class="grid gap-6 lg:grid-cols-[26rem_1fr]">
          <div class="card border-base-300 bg-base-200 h-fit border">
            <div class="card-body gap-4">
              <!--
                The build planner's card, field for field. A build is placed by naming it, typing
                where its corner lands, and saying which server and world those numbers are in; a
                region is placed by naming it and typing two corners instead of one. Everything
                around that one difference is the same card, in the same order, with the same
                labels — two screens that ask the same question should not look like two questions.
              -->
              <h2 class="card-title flex items-center gap-2 text-base">
                <component :is="JOB_ICON[kind]" class="size-4" :style="jobStyle(kind)" />
                {{ t(`region.${kind}.title`) }}
              </h2>

              <!--
                Several regions of one kind is the ordinary case — three quarries on one server —
                so the picker is here from the first one, because the row beside it is how a second
                gets made.
              -->
              <div v-if="mine.length" class="form-control">
                <span class="label-text text-xs opacity-60">{{ t(`region.${kind}.which`) }}</span>
                <div class="mt-1 flex items-center gap-1">
                  <select
                    class="select select-sm min-w-0 flex-1"
                    :value="selectedId ?? ''"
                    @change="choose(Number(($event.target as HTMLSelectElement).value) || null)"
                  >
                    <option v-for="region in mine" :key="region.id" :value="region.id">
                      {{ region.name }}
                    </option>
                    <!-- The unsaved one is in the list while it is being written, so the control
                         never claims the operator is editing something they are not. -->
                    <option v-if="selectedId === null" value="">{{ t('region.newOption') }}</option>
                  </select>

                  <template v-if="auth.can('agent.run')">
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm shrink-0 px-2"
                      :title="t('region.new')"
                      :disabled="selectedId === null"
                      @click="choose(null)"
                    >
                      <Plus class="size-4" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm shrink-0 px-2"
                      :title="t('region.rename')"
                      :disabled="!selected"
                      @click="openRename"
                    >
                      <SquarePen class="size-4" />
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm shrink-0 px-2"
                      :title="t('region.remove')"
                      :disabled="!selected || !auth.can('agent.delete')"
                      @click="removeDialog?.showModal()"
                    >
                      <Trash2 class="size-4" />
                    </button>
                  </template>
                </div>
              </div>

              <div>
                <p class="flex items-center gap-2 text-sm font-medium">
                  <MapPin class="text-base-content/50 size-4" />
                  {{ t('region.placement') }}
                </p>
                <p class="mt-1 text-xs opacity-60">{{ t('builds.placementHint') }}</p>

                <!--
                  Two corners rather than a corner and a size, because two corners are what an
                  operator has: they stand at one end, read the coordinate, walk to the other and
                  read it again. Either way round — the box is sorted here and again on the backend.

                  **One table, not two stacked forms.** A build plan places one corner, so its axis
                  labels sit over its three boxes and that is the whole of it. Repeating that for a
                  second corner put two rows of labels above two rows of boxes, and the eye had no
                  way to tell which belonged to which. So the axes are named once along the top, the
                  corners once down the side, and each box sits where its row meets its column.

                  The autocomplete guards are the plan card's, for the plan card's reason: a bare
                  numeric input one character wide is exactly what a browser decides must be part of
                  an address block.

                  Padding rather than a margin underneath: what follows has a top margin of its own,
                  and two adjacent margins in normal flow collapse into the larger of the two.
                -->
                <div
                  class="mt-3 grid items-center gap-x-2 gap-y-1 pb-2"
                  :class="
                    digging
                      ? 'grid-cols-[2.25rem_repeat(3,minmax(0,1fr))]'
                      : 'grid-cols-[2.25rem_repeat(2,minmax(0,1fr))]'
                  "
                >
                  <span></span>
                  <span
                    v-for="axis in axes"
                    :key="axis"
                    class="label-text text-center text-xs uppercase opacity-50"
                  >
                    {{ axis }}
                  </span>

                  <template v-for="corner in ([['from', from], ['to', to]] as const)" :key="corner[0]">
                    <span class="label-text text-xs uppercase opacity-50">
                      {{ t(`region.${corner[0]}`) }}
                    </span>
                    <input
                      v-for="axis in axes"
                      :key="`${corner[0]}-${axis}`"
                      v-model.number="corner[1][axis]"
                      type="number"
                      :name="`${corner[0]}-${axis}`"
                      :aria-label="`${t(`region.${corner[0]}`)} ${axis.toUpperCase()}`"
                      autocomplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      class="input input-sm w-full tabular-nums"
                    />
                  </template>
                </div>

                <!--
                  Charting is flat work, so the height is where the agents fly rather than a side of
                  the box. A second Y on the corners would be a number nothing reads.
                -->
                <label v-if="!digging" class="form-control">
                  <span class="label-text text-xs uppercase opacity-50">
                    {{ rising ? t('region.lowestHeight') : t('region.height') }}
                  </span>
                  <input
                    v-model.number="height"
                    type="number"
                    name="flying-height"
                    autocomplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    class="input input-sm w-full tabular-nums"
                  />
                </label>

                <!--
                  The height a survey holds is only flyable where the ground allows it, and the
                  ground is the thing being charted. So it can be made a floor instead: the crew
                  lifts over whatever stands in the way and settles back down to it.

                  The field above stays, and stays required - a climb has to start somewhere, and
                  the box is still the one-block slab everything else here already understands.
                -->
                <label v-if="!digging" class="mt-3 flex cursor-pointer items-start gap-3">
                  <input v-model="rising" type="checkbox" class="toggle toggle-sm" />
                  <span class="flex flex-col gap-0.5">
                    <span class="text-sm">{{ t('region.rising') }}</span>
                    <span class="text-xs opacity-60">{{ t('region.risingHint') }}</span>
                  </span>
                </label>

                <p v-if="boxFault" class="text-warning mt-2 text-xs">{{ boxFault }}</p>
                <p v-else-if="size" class="mt-2 text-xs opacity-50">
                  {{
                    t(`region.${kind}.measured`, {
                      x: size.x,
                      y: size.y,
                      z: size.z,
                      blocks: n(volume),
                    })
                  }}
                </p>
                <p v-else class="mt-2 text-xs opacity-50">{{ t('region.unplaced') }}</p>

                <!--
                  The world those numbers are in, said the way a build plan says it: the same two
                  selects, in the same order, with the same reason for the server being one — the
                  address has to match what agents report, character for character, or no agent is
                  ever eligible.

                  Neither may be left blank here, where a build plan's may. A schematic is a shape
                  that exists on its own; six coordinates are only a place once they say which world
                  they were read in.
                -->
                <div class="mt-3 grid grid-cols-2 gap-2">
                  <label class="form-control min-w-0">
                    <span class="label-text text-xs opacity-50">{{ t('builds.server') }}</span>
                    <select v-model="wantedServer" class="select select-sm w-full">
                      <option value="">{{ t('builds.anyServer') }}</option>
                      <option v-for="address in servers" :key="address" :value="address">
                        {{ address }}
                      </option>
                    </select>
                  </label>
                  <label class="form-control min-w-0">
                    <span class="label-text text-xs opacity-50">{{ t('builds.dimension') }}</span>
                    <select v-model="dimension" class="select select-sm w-full">
                      <option value="">{{ t('builds.anyDimension') }}</option>
                      <option v-for="world in dimensions" :key="world" :value="world">
                        {{ dimensionLabel(world) }}
                      </option>
                    </select>
                  </label>
                </div>
                <p class="mt-1 text-xs opacity-50">{{ t('builds.serverHint') }}</p>
              </div>

              <!--
                Which of the two is showing is the answer to "did that go through" — said inline,
                where the build planner says it, rather than as a banner over the page. A save that
                reports nothing is indistinguishable from a button that does nothing.
              -->
              <div v-if="auth.can('agent.run')" class="flex items-center gap-2">
                <span v-if="unsavable" class="text-xs opacity-50">{{ unsavable }}</span>
                <span v-else-if="dirty" class="text-warning text-xs">{{ t('builds.unsaved') }}</span>
                <span v-else-if="saved" class="text-success flex items-center gap-1 text-xs">
                  <Check class="size-3.5" />
                  {{ saved }}
                </span>

                <button
                  type="button"
                  class="btn btn-primary btn-sm ml-auto gap-2"
                  :disabled="!!unsavable || saving || !dirty"
                  @click="save"
                >
                  <Save class="size-4" />
                  {{ selected ? t('region.saveChanges') : t('region.saveNew') }}
                </button>
              </div>
            </div>
          </div>

          <!-- What the corners actually describe, drawn the way a division is drawn. -->
          <BoxViewer :boxes="boxes" corners />
        </div>

        <!-- ─── Who ─────────────────────────────────────────────────────────── -->
        <div v-else-if="step === 'agents'" class="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <AgentPicker
            v-model="crew"
            :agents="eligible"
            :unavailable="blocked"
            :unavailable-note="t('region.cannotWork')"
            :title="t('schematics.builders')"
          />

          <div class="card border-base-300 bg-base-200 h-fit border">
            <div class="card-body gap-4">
              <h2 class="card-title text-base">{{ t('region.summary') }}</h2>

              <!--
                Where it is going, stated rather than chosen: the plan says which server, and a
                second control for it would be a way to disagree with it.
              -->
              <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt class="opacity-60">{{ t('region.serverLabel') }}</dt>
                <dd>{{ selected?.serverAddress }}</dd>

                <dt class="opacity-60">{{ t('region.dimension') }}</dt>
                <dd>{{ dimensionLabel(selected?.dimension ?? dimension) }}</dd>

                <!-- Always there by this step: an unplaced region cannot be advanced past the
                     first one. Guarded all the same, because the type says it can be null. -->
                <dt class="opacity-60">{{ t('region.sizeLabel') }}</dt>
                <dd class="tabular-nums">
                  {{ size ? `${size.x} × ${size.y} × ${size.z}` : '—' }}
                </dd>

                <dt class="opacity-60">{{ t(`region.${kind}.volume`) }}</dt>
                <dd class="tabular-nums">{{ n(Math.max(0, volume)) }}</dd>

                <!-- How it is flown, which is the one thing about a survey that is not the box. -->
                <template v-if="!digging">
                  <dt class="opacity-60">{{ t('region.flight') }}</dt>
                  <dd>{{ rising ? t('region.risingAt', { y: height }) : t('region.levelAt', { y: height }) }}</dd>
                </template>
              </dl>
            </div>
          </div>
        </div>

        <!-- ─── Divided how ─────────────────────────────────────────────────── -->
        <div v-else-if="step === 'split'" class="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <div class="card border-base-300 bg-base-200 h-fit border">
            <div class="card-body gap-4">
              <h2 class="card-title text-base">{{ t('schematics.splitTitle') }}</h2>

              <!-- A slab one block thick has no height to cut, so charting is always strips. -->
              <label v-if="digging" class="form-control">
                <span class="label-text text-xs opacity-60">{{ t('schematics.mode') }}</span>
                <select v-model="mode" class="select select-sm w-full">
                  <option
                    v-for="option in (['COLUMNS', 'GRID'] as SplitMode[])"
                    :key="option"
                    :value="option"
                  >
                    {{ t(`schematics.mode${option}`) }}
                  </option>
                </select>
              </label>
              <!-- The mode hint stays: which of the two balances and which parallelises is the one
                   thing about a division that cannot be read off the control. -->
              <p v-if="digging" class="text-xs opacity-60">{{ t(`schematics.modeHint${mode}`) }}</p>

              <!--
                Blank rather than pre-filled: an empty field means one piece each, which is what
                somebody who does not want to think about it should get. A bigger number is what
                makes agents queue for work instead of owning a share of it.
              -->
              <label class="form-control">
                <span class="label-text text-xs opacity-60">
                  {{ digging ? t('schematics.parts') : t('region.strips') }}
                </span>
                <input
                  v-model.number="wantedParts"
                  type="number"
                  min="1"
                  :max="MAX_PARTS"
                  class="input input-sm w-full"
                  :placeholder="t('schematics.partsDefault', { count: crew.length })"
                />
              </label>

              <p v-if="parts > crew.length" class="text-xs opacity-60">
                {{ t('schematics.partsQueue', { parts, agents: crew.length }) }}
              </p>

              <!--
                The same button the build wizard has, doing the same thing: the division is asked of
                the backend and drawn, so what an operator looks at is what the agents will be given.
              -->
              <button
                type="button"
                class="btn btn-primary btn-sm gap-2"
                :disabled="splitting || !parts"
                @click="runSplit"
              >
                <Scissors class="size-4" />
                {{
                  splitting
                    ? t('schematics.splitting')
                    : t('schematics.splitBetween', { count: parts })
                }}
              </button>

              <template v-if="split">
                <p v-if="split.parts < split.requested" class="text-warning text-xs">
                  {{ t('schematics.splitShort', { parts: split.parts, requested: split.requested }) }}
                </p>

                <ul class="divide-base-300 max-h-72 divide-y overflow-y-auto text-sm">
                  <li
                    v-for="segment in split.segments"
                    :key="segment.ordinal"
                    class="flex items-center justify-between gap-4 py-1.5"
                  >
                    <span class="opacity-80">
                      {{ t('schematics.segment', { ordinal: segment.ordinal }) }}
                    </span>
                    <span class="tabular-nums opacity-60">
                      {{
                        t('schematics.segmentShare', {
                          blocks: n(segment.blocks),
                          percent: segment.sharePercent,
                        })
                      }}
                    </span>
                  </li>
                </ul>
              </template>

              <!-- Said before anybody presses rather than after, and only where it is true:
                   a survey is flown, and nothing yet digs. -->
              <p v-if="digging" class="text-xs opacity-60">{{ t('jobs.notDispatched') }}</p>
              <p v-else class="text-xs opacity-60">{{ t('region.flownBy', { count: crew.length }) }}</p>
            </div>
          </div>

          <BoxViewer :boxes="splitBoxes ?? boxes" :corners="!splitBoxes" />
        </div>

        <!-- ─── In what order ───────────────────────────────────────────────── -->
        <div v-else class="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <div class="card border-base-300 bg-base-200 h-fit border">
            <div class="card-body gap-4">
              <h2 class="card-title text-base">{{ t('schematics.orderTitle') }}</h2>
              <OrderPicker v-model="order" />
              <p class="font-mono text-xs opacity-50">{{ formatOrder(order) }}</p>
            </div>
          </div>

          <div class="card border-base-300 bg-base-200 h-fit border">
            <div class="card-body items-center gap-2">
              <OrderPreview :order="order" class="max-w-sm" />
              <p class="text-center text-xs opacity-60">{{ t('order.previewHint') }}</p>
            </div>
          </div>
        </div>
      </Transition>
    </SwapBox>

    <!-- ─── Moving between the steps ──────────────────────────────────────── -->
    <div class="border-base-300 flex items-center gap-3 border-t pt-4">
      <button type="button" class="btn btn-ghost btn-sm" :disabled="step === 'region'" @click="back">
        {{ t('schematics.back') }}
      </button>

      <span v-if="!canAdvance && !last && missing" class="text-xs opacity-50">{{ missing }}</span>

      <button
        v-if="!last"
        type="button"
        class="btn btn-primary btn-sm ml-auto"
        :disabled="!canAdvance"
        @click="next"
      >
        {{ t('schematics.next') }}
      </button>

      <div v-else class="ml-auto flex items-center gap-3">
        <span v-if="blocking" class="text-xs opacity-50">{{ blocking }}</span>
        <button
          type="button"
          class="btn btn-primary btn-sm gap-2"
          :disabled="!!blocking || starting"
          @click="start"
        >
          <span v-if="starting" class="loading loading-spinner loading-xs" />
          <Play v-else class="size-4" />
          {{ starting ? t('region.starting') : t(`region.${kind}.start`) }}
        </button>
      </div>
    </div>

    <!--
      The build planner's two dialogs, shape for shape: the same heading, the same icon and tone,
      the same field component, the same pair of buttons in the same order with the same busy
      wording. Renaming is its own act either way — the card writes coordinates, and a name is not
      one — and there is no reason for the same act to look different on three tabs.
    -->
    <ModalShell ref="renameDialog" :title="t('region.renameTitle')" :icon="SquarePen">
      <p class="mt-1 text-sm opacity-60">{{ t('region.renameHint') }}</p>
      <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveName">
        <FormField
          v-model="nameDraft"
          :label="t('region.planName')"
          :icon="SquarePen"
          type="text"
          maxlength="128"
          required
        />
        <div class="modal-action">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="busy"
            @click="renameDialog?.close()"
          >
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy">
            {{ busy ? t('common.saving') : t('common.save') }}
          </button>
        </div>
      </form>
    </ModalShell>

    <ModalShell
      ref="removeDialog"
      :title="t('region.removeTitle', { name: selected?.name ?? '' })"
      :icon="Trash2"
      tone="error"
    >
      <p class="mt-3 text-sm opacity-70">{{ t('region.removeWarning') }}</p>
      <div class="modal-action">
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="busy"
          @click="removeDialog?.close()"
        >
          {{ t('common.cancel') }}
        </button>
        <button class="btn btn-error btn-sm gap-2" type="button" :disabled="busy" @click="remove">
          <Trash2 class="size-4" />
          {{ busy ? t('common.deleting') : t('region.removePlan') }}
        </button>
      </div>
    </ModalShell>
  </div>
</template>
