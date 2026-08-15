<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Box,
  Hammer,
  Scissors,
  Search,
  Server,
  TriangleAlert,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import AgentPicker from './AgentPicker.vue'
import BoxViewer from './BoxViewer.vue'
import SchematicUploadModal from './SchematicUploadModal.vue'
import {
  deleteSchematic,
  listSchematics,
  schematicMaterials,
  splitSchematic,
  type SchematicResponse,
  type SplitMode,
  type SplitResponse,
} from '../api/schematics'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import type { Box as Box3d } from '../lib/box3d'

/**
 * Starting a build: choose what, choose who, divide it up.
 *
 * **Three steps rather than one screen.** All of it at once is a library, a viewer, a material
 * list, an agent picker, a mode, and a set of segments competing for the same attention — and the
 * order between them is not obvious from looking, even though it is strict: nothing can be divided
 * before it has been read, and it cannot be divided at all until somebody is going to build it.
 * Steps make that order the shape of the screen.
 *
 * Each step keeps the layout the rest of Operations uses — a panel on the left, the thing it acts
 * on beside it — so moving between steps and between tabs feels like the same application.
 *
 * Nothing here polls: upload and analysis both run for minutes on a real file, and the rows arrive
 * on the same live stream the fleet uses.
 */
const { t, n } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()

const emit = defineEmits<{ failed: [string] }>()

const STEPS = ['schematic', 'agents', 'split'] as const
type Step = (typeof STEPS)[number]

const step = ref<Step>('schematic')
const uploadOpen = ref(false)

const schematics = ref<SchematicResponse[]>([])
const selectedId = ref<number | null>(null)
const materials = ref<Array<{ name: string; blocks: number }>>([])

const query = ref('')

/**
 * The list, filtered. The one being looked at stays in it whatever is typed — hiding the schematic
 * whose shape fills the rest of the step, because its name does not match a half-typed search, is
 * the list contradicting the panel beside it.
 */
const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return schematics.value

  return schematics.value.filter(
    (schematic) =>
      schematic.id === selectedId.value ||
      schematic.name.toLowerCase().includes(needle) ||
      schematic.originalFilename.toLowerCase().includes(needle),
  )
})

const selected = computed(() => schematics.value.find((item) => item.id === selectedId.value) ?? null)

/** A schematic that has not been read has no shape, no materials and nothing to divide. */
const ready = computed(() => selected.value?.status === 'READY')

/**
 * The box as the operator will place it. Its own coordinates, not a normalised one: the corner
 * labels are the numbers they will type into a placement, so they have to be the real ones.
 */
const boxes = computed<Box3d[]>(() => {
  const content = selected.value?.content
  if (!content?.sizeX || !content.sizeY || !content.sizeZ) return []

  const min = { x: content.originX ?? 0, y: content.originY ?? 0, z: content.originZ ?? 0 }
  return [
    {
      id: String(selected.value!.id),
      min,
      max: { x: min.x + content.sizeX, y: min.y + content.sizeY, z: min.z + content.sizeZ },
    },
  ]
})

/**
 * Who builds it, and therefore where.
 *
 * **One server.** A build happens on one Minecraft server, so agents on two of them cannot share
 * one — they would be placing blocks into different worlds that happen to have the same
 * coordinates. The first pick decides which server this is, and the rest of the fleet becomes
 * unavailable rather than disappearing: an operator hunting for an agent that is right there has
 * learned nothing, while one told why it cannot be chosen has.
 *
 * The count is the selection. Asking for a number of agents *and* which agents is asking the same
 * question twice, and lets the two disagree.
 */
const builders = ref<number[]>([])

const buildServer = computed(() => {
  const first = agentStore.agents.find((agent) => agent.id === builders.value[0])
  return first?.serverAddress ?? null
})

const eligibleBuilders = computed(() =>
  agentStore.agents.filter(
    (agent) =>
      agent.serverAddress !== null &&
      (buildServer.value === null || agent.serverAddress === buildServer.value),
  ),
)

const blockedBuilders = computed(() =>
  agentStore.agents.filter((agent) => !eligibleBuilders.value.includes(agent)),
)

const parts = computed(() => builders.value.length)

const MODES: SplitMode[] = ['COLUMNS', 'LAYERS', 'GRID']
const mode = ref<SplitMode>('COLUMNS')
const splitting = ref(false)
const split = ref<SplitResponse | null>(null)

/**
 * The segments, as boxes. Null until a split has been asked for, which is what the viewer uses to
 * decide whether it is showing the schematic or its division.
 */
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

/** What has to be true before the next step means anything. */
const canAdvance = computed(() =>
  step.value === 'schematic' ? ready.value : step.value === 'agents' ? parts.value > 0 : false,
)

function go(to: Step) {
  // Backwards is always allowed; forwards only past a step that has been answered. A step reached
  // without its answer is a panel that cannot do anything, which reads as the screen being broken.
  const target = STEPS.indexOf(to)
  const here = STEPS.indexOf(step.value)
  if (target > here && !canAdvance.value) return
  step.value = to
}

function next() {
  const at = STEPS.indexOf(step.value)
  if (at < STEPS.length - 1 && canAdvance.value) step.value = STEPS[at + 1]!
}

function back() {
  const at = STEPS.indexOf(step.value)
  if (at > 0) step.value = STEPS[at - 1]!
}

onMounted(async () => {
  await refresh()
  // Every schematic event, including the ones that only moved a progress bar. The store owns the
  // one stream; this is a list, so it arrives through the same channel the other lists use.
  stop = agentStore.onFeedEvent((event, data) => {
    if (event === 'schematic') apply(data as SchematicResponse)
    if (event === 'schematic-removed') {
      const { id } = data as { id: number }
      schematics.value = schematics.value.filter((item) => item.id !== id)
      if (selectedId.value === id) selectedId.value = null
    }
  })
})

let stop: (() => void) | null = null

onUnmounted(() => stop?.())

async function refresh() {
  try {
    schematics.value = await listSchematics()
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  }
}

function apply(incoming: SchematicResponse) {
  const index = schematics.value.findIndex((item) => item.id === incoming.id)
  if (index === -1) schematics.value = [incoming, ...schematics.value]
  else schematics.value[index] = incoming
}

function uploaded(schematic: SchematicResponse) {
  apply(schematic)
  selectedId.value = schematic.id
}

async function runSplit() {
  if (!selected.value || !parts.value) return

  splitting.value = true
  try {
    split.value = await splitSchematic(selected.value.id, mode.value, parts.value)
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    splitting.value = false
  }
}

// A division belongs to one schematic, one mode and one set of agents. Left on screen after any of
// them changes, it would be a picture of a different question's answer.
watch([selectedId, mode, parts], () => {
  split.value = null
})

/** Materials exist only once the file has been read, and only for the one being looked at. */
watch(
  () => [selectedId.value, selected.value?.status] as const,
  async ([id, status]) => {
    materials.value = []
    if (id === null || status !== 'READY') return
    try {
      materials.value = (await schematicMaterials(id)) as Array<{ name: string; blocks: number }>
    } catch {
      // A missing material list is not worth an alert over the shape it belongs to.
    }
  },
  { immediate: true },
)

/**
 * Deleting takes the file with it, so it asks first — in a dialog rather than `window.confirm`.
 *
 * The native one cannot say which schematic, cannot be read by anyone using the interface in
 * German, and looks like the browser warning about a script. The thing being destroyed is a file
 * that may have taken an hour to upload; the question about it should be part of the application.
 */
const pendingDelete = ref<SchematicResponse | null>(null)
const deleteDialog = ref<HTMLDialogElement | null>(null)

function askToRemove(schematic: SchematicResponse) {
  pendingDelete.value = schematic
  deleteDialog.value?.showModal()
}

async function confirmRemove() {
  const schematic = pendingDelete.value
  if (!schematic) return

  try {
    await deleteSchematic(schematic.id)
    schematics.value = schematics.value.filter((item) => item.id !== schematic.id)
    if (selectedId.value === schematic.id) selectedId.value = null
  } catch (failure) {
    emit('failed', failure instanceof Error ? failure.message : t('errors.generic'))
  } finally {
    deleteDialog.value?.close()
  }
}

const statusTone: Record<string, string> = {
  UPLOADING: 'badge-info',
  PENDING: 'badge-ghost',
  ANALYSING: 'badge-warning',
  READY: 'badge-success',
  FAILED: 'badge-error',
}

function bytes(count: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = count
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!--
      The order is strict — nothing divides before it has been read, and nothing divides at all
      until somebody is going to build it — so it is drawn rather than left to be discovered.
    -->
    <ul class="steps w-full">
      <li
        v-for="(name, index) in STEPS"
        :key="name"
        class="step cursor-pointer"
        :class="STEPS.indexOf(step) >= index ? 'step-primary' : ''"
        @click="go(name)"
      >
        {{ t(`schematics.step_${name}`) }}
      </li>
    </ul>

    <!-- ─── Choose what to build ─────────────────────────────────────────────── -->
    <div v-if="step === 'schematic'" class="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <!--
        The library scrolls inside itself. A fleet with thirty schematics would otherwise make the
        column taller than the panel beside it, and scrolling the page to reach a list moves the
        thing the list is describing off the screen.
      -->
      <div class="card border-base-300 bg-base-200 h-fit border">
        <div class="card-body gap-2 p-3">
          <div class="flex items-center justify-between px-2 pt-1">
            <h2 class="text-base font-semibold">{{ t('schematics.title') }}</h2>
            <button
              v-if="auth.can('schematic.write')"
              type="button"
              class="btn btn-primary btn-xs gap-1"
              @click="uploadOpen = true"
            >
              <Upload class="size-3.5" />
              {{ t('schematics.upload') }}
            </button>
          </div>

          <!--
            Matched against the file's original name as well as the operator's. Two uploads of the
            same build under names that have drifted apart are exactly when a search is reached for,
            and the filename is the half that did not drift.
          -->
          <label v-if="schematics.length > 5" class="input input-sm mx-1">
            <Search class="size-4 opacity-60" />
            <input v-model="query" type="search" :placeholder="t('schematics.filterPlaceholder')" />
          </label>

          <p v-if="!schematics.length" class="p-3 text-sm opacity-60">{{ t('schematics.empty') }}</p>
          <p v-else-if="!visible.length" class="p-3 text-sm opacity-60">
            {{ t('schematics.noMatches') }}
          </p>

          <div v-else class="flex max-h-[32rem] flex-col gap-0.5 overflow-y-auto">
          <button
            v-for="schematic in visible"
            :key="schematic.id"
            type="button"
            class="hover:bg-base-300 flex flex-col gap-1 rounded-lg px-3 py-2 text-left"
            :class="schematic.id === selectedId ? 'bg-base-300' : ''"
            @click="selectedId = schematic.id"
          >
            <span class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{{ schematic.name }}</span>
              <span class="badge badge-xs ml-auto shrink-0" :class="statusTone[schematic.status]">
                {{ t(`schematics.status${schematic.status}`) }}
              </span>
            </span>

            <!--
              One bar for two stages. An operator watching an upload does not care where sending
              ends and reading begins; they care that it is still moving.
            -->
            <progress
              v-if="schematic.status === 'UPLOADING' || schematic.status === 'ANALYSING'"
              class="progress progress-primary h-1 w-full"
              :value="schematic.progressPercent"
              max="100"
            ></progress>

            <span class="text-xs opacity-50">
              {{ bytes(schematic.sizeBytes) }}
              <template v-if="schematic.content.blockCount">
                · {{ n(schematic.content.blockCount) }} {{ t('schematics.blocks').toLowerCase() }}
              </template>
            </span>
          </button>
          </div>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 h-fit border">
        <div class="card-body gap-4">
          <p v-if="!selected" class="text-sm opacity-60">{{ t('schematics.selectHint') }}</p>

          <template v-else>
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="card-title text-base">{{ selected.name }}</h2>
              <span class="badge badge-sm" :class="statusTone[selected.status]">
                {{ t(`schematics.status${selected.status}`) }}
              </span>
              <button
                v-if="auth.can('schematic.delete')"
                type="button"
                class="btn btn-ghost btn-xs ml-auto gap-1"
                @click="askToRemove(selected)"
              >
                <Trash2 class="size-3.5" />
                {{ t('schematics.delete') }}
              </button>
            </div>

            <div v-if="selected.failure" role="alert" class="alert alert-error alert-soft text-sm">
              {{ selected.failure }}
            </div>

            <!--
              Not a refusal — an older Minecraft is accepted on purpose, because most blocks do not
              change between versions. But the ones that were renamed are invisible until an agent
              fails to place one, and this is the only place that can say so before then.
            -->
            <div
              v-if="selected.content.outdated"
              role="status"
              class="alert alert-warning alert-soft items-start text-sm"
            >
              <TriangleAlert class="mt-0.5 size-4 shrink-0" />
              <span>
                <strong class="font-medium">{{ t('schematics.outdated') }}</strong>
                <span class="block opacity-80">
                  {{ t('schematics.outdatedHint', { version: selected.content.dataVersion }) }}
                </span>
              </span>
            </div>

            <!--
              Shape beside its facts rather than above them. Stacked, the three of them are taller
              than any screen and the material list is reached by scrolling past a picture that has
              already been looked at. Each column carries its own scroll, so the page keeps none.
            -->
            <div v-if="ready" class="grid gap-4 xl:grid-cols-[1fr_15rem]">
              <div class="flex min-w-0 flex-col gap-2">
                <BoxViewer :boxes="boxes" corners />
                <p class="text-xs opacity-50">{{ t('schematics.dragHint') }}</p>
              </div>

              <div class="flex min-w-0 flex-col gap-3">
                <div class="stats stats-vertical border-base-300 w-full border">
                  <div class="stat px-4 py-3">
                    <div class="stat-title text-xs">{{ t('schematics.blocks') }}</div>
                    <div class="stat-value text-xl">{{ n(selected.content.blockCount ?? 0) }}</div>
                  </div>
                  <div class="stat px-4 py-3">
                    <div class="stat-title text-xs">{{ t('schematics.size') }}</div>
                    <div class="stat-value text-xl">
                      {{ selected.content.sizeX }}×{{ selected.content.sizeY }}×{{ selected.content.sizeZ }}
                    </div>
                  </div>
                </div>

                <div class="border-base-300 flex min-h-0 flex-col rounded-lg border">
                  <p class="border-base-300 border-b px-3 py-2 text-xs font-medium">
                    {{ t('schematics.materials') }}
                    <span class="ml-1 opacity-50">{{ materials.length }}</span>
                  </p>
                  <p v-if="!materials.length" class="px-3 py-2 text-sm opacity-60">
                    {{ t('schematics.noMaterials') }}
                  </p>
                  <ul v-else class="divide-base-300 max-h-56 divide-y overflow-y-auto text-sm">
                    <li
                      v-for="material in materials"
                      :key="material.name"
                      class="flex items-center justify-between gap-3 px-3 py-1.5"
                    >
                      <span class="truncate opacity-80">
                        {{ material.name.replace('minecraft:', '') }}
                      </span>
                      <span class="shrink-0 tabular-nums opacity-60">{{ n(material.blocks) }}</span>
                    </li>
                  </ul>
                </div>

                <p class="mt-auto text-xs opacity-40">
                  {{ t('schematics.uploadedBy', { name: selected.uploadedBy }) }} ·
                  {{ selected.originalFilename }}
                </p>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ─── Choose who builds it ─────────────────────────────────────────────── -->
    <div v-else-if="step === 'agents'" class="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <AgentPicker
        v-model="builders"
        :agents="eligibleBuilders"
        :unavailable="blockedBuilders"
        :unavailable-note="t('schematics.oneServerOnly')"
        :title="t('schematics.builders')"
      />

      <div class="card border-base-300 bg-base-200 h-fit border">
        <div class="card-body gap-4">
          <h2 class="card-title text-base">{{ t('schematics.buildTitle') }}</h2>

          <!--
            Where it is going, stated rather than chosen: the agents decide the server, and a second
            control for it would be a way to disagree with them.
          -->
          <div class="flex flex-col gap-3 text-sm">
            <p class="flex items-center gap-2">
              <Box class="text-primary size-4 shrink-0" />
              <span class="opacity-60">{{ t('schematics.buildingWhat') }}</span>
              <span class="font-medium">{{ selected?.name }}</span>
              <span class="ml-auto tabular-nums opacity-60">
                {{ n(selected?.content.blockCount ?? 0) }} {{ t('schematics.blocks').toLowerCase() }}
              </span>
            </p>

            <p class="flex items-center gap-2">
              <Server class="text-primary size-4 shrink-0" />
              <span class="opacity-60">{{ t('schematics.buildingOn') }}</span>
              <span v-if="buildServer" class="font-mono">{{ buildServer }}</span>
              <span v-else class="italic opacity-60">{{ t('schematics.pickBuilders') }}</span>
            </p>

            <p v-if="parts" class="flex items-center gap-2">
              <Hammer class="text-primary size-4 shrink-0" />
              <span class="opacity-60">{{ t('schematics.builders') }}</span>
              <span class="font-medium">{{ parts }}</span>
              <span class="ml-auto tabular-nums opacity-60">
                {{ n(Math.round((selected?.content.blockCount ?? 0) / parts)) }}
                {{ t('schematics.blocksEach') }}
              </span>
            </p>
          </div>

          <!--
            The shape again, small. This step is otherwise a list on one side and three lines on the
            other, and an operator choosing who builds something should be able to see the thing
            without going back a step to look at it.
          -->
          <BoxViewer v-if="ready" :boxes="boxes" />
        </div>
      </div>
    </div>

    <!-- ─── Divide it up ─────────────────────────────────────────────────────── -->
    <div v-else class="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <div class="card border-base-300 bg-base-200 h-fit border">
        <div class="card-body gap-4">
          <h2 class="card-title text-base">{{ t('schematics.splitTitle') }}</h2>

          <label class="form-control">
            <span class="label-text text-xs opacity-60">{{ t('schematics.mode') }}</span>
            <select v-model="mode" class="select select-sm w-full">
              <option v-for="option in MODES" :key="option" :value="option">
                {{ t(`schematics.mode${option}`) }}
              </option>
            </select>
          </label>

          <p class="text-xs opacity-60">{{ t(`schematics.modeHint${mode}`) }}</p>

          <button
            type="button"
            class="btn btn-primary btn-sm gap-2"
            :disabled="splitting || !parts"
            @click="runSplit"
          >
            <Scissors class="size-4" />
            {{ splitting ? t('schematics.splitting') : t('schematics.splitBetween', { count: parts }) }}
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
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <!--
          One viewer for both pictures. The split is the same shape divided, and drawing it
          differently would make it harder to recognise as the thing it came from — so the boxes
          change and nothing else does. Corner coordinates are dropped once there are several:
          eight labels per segment is not a reading of anything.
        -->
        <BoxViewer :boxes="splitBoxes ?? boxes" :corners="!splitBoxes" />
        <p class="text-xs opacity-50">{{ t('schematics.dragHint') }}</p>
      </div>
    </div>

    <!-- ─── Moving between the steps ─────────────────────────────────────────── -->
    <div class="border-base-300 flex items-center gap-3 border-t pt-4">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="step === 'schematic'"
        @click="back"
      >
        {{ t('schematics.back') }}
      </button>

      <!-- Says what is missing rather than only refusing: a disabled button with no reason is the
           interface declining to explain itself. -->
      <span v-if="!canAdvance && step !== 'split'" class="text-xs opacity-50">
        {{ step === 'schematic' ? t('schematics.needSchematic') : t('schematics.needBuilders') }}
      </span>

      <button
        v-if="step !== 'split'"
        type="button"
        class="btn btn-primary btn-sm ml-auto"
        :disabled="!canAdvance"
        @click="next"
      >
        {{ t('schematics.next') }}
      </button>

      <div v-else class="ml-auto flex items-center gap-3">
        <span class="text-xs opacity-50">{{ t('schematics.awaitingHost') }}</span>
        <button type="button" class="btn btn-primary btn-sm gap-2" disabled>
          <Hammer class="size-4" />
          {{ t('schematics.startBuilding') }}
        </button>
      </div>
    </div>

    <SchematicUploadModal v-model:open="uploadOpen" @created="uploaded" />

    <dialog ref="deleteDialog" class="modal" @close="pendingDelete = null">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <Trash2 class="text-error size-5" />
          {{ t('schematics.deleteTitle', { name: pendingDelete?.name ?? '' }) }}
        </h3>
        <p class="mt-3 text-sm opacity-70">{{ t('schematics.deleteWarning') }}</p>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="deleteDialog?.close()">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-error btn-sm gap-2" type="button" @click="confirmRemove">
            <Trash2 class="size-4" />
            {{ t('schematics.delete') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{{ t('common.close') }}</button>
      </form>
    </dialog>
  </div>
</template>
