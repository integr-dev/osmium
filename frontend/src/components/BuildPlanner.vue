<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, MapPin, Plus, Replace, RotateCw, SquarePen, Trash2 } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'
import AlertNote from './AlertNote.vue'
import {
  createBuild,
  deleteBuild,
  listBuilds,
  updateBuild,
  type BuildResponse,
} from '../api/builds'
import BlockPicker from './BlockPicker.vue'
import FormField from './FormField.vue'
import { blockColour } from '../lib/blockColours'
import { blockId, blockName } from '../lib/blockNames'
import {
  blocksToPlace,
  DIMENSIONS,
  offsetOf,
  plannedMaterials,
  QUARTERS,
  quarterOf,
  sameSubstitutions,
  worldId,
  type Quarter,
  type Substitution,
} from '../lib/placement'
import type { Vec3 } from '../lib/box3d'
import { dimensionLabel } from '../lib/vitals'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * Where a build stands and what it is built out of.
 *
 * Both belong to a **plan** rather than to the schematic, because the same schematic is legitimately
 * built more than once — the same tower on two servers, or twice on one under different
 * substitutions. Which is why this offers the plans for a schematic rather than editing one set of
 * fields hanging off the file.
 *
 * Everything shown is computed here from the plan and the material list. The backend stores the
 * decision; the consequences of it are arithmetic — see `lib/placement.ts`.
 */
const props = defineProps<{
  schematicId: number
  schematicName: string
  /** The schematic's own minimum corner, which the placement is measured against. */
  origin: Vec3
  materials: Array<{ name: string; blocks: number }>
}>()

const emit = defineEmits<{ planned: [BuildResponse | null] }>()

const { t, n } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()

const plans = ref<BuildResponse[]>([])
const selectedId = ref<number | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
/** What the last save came to, cleared the moment the draft moves away from it again. */
const saved = ref<string | null>(null)

/** The draft, which is what the fields edit. Committed to the plan only when saved. */
const place = ref<{ x: number | null; y: number | null; z: number | null }>({ x: null, y: null, z: null })

/**
 * Which world the coordinates are in, and which way round the build goes.
 *
 * A coordinate is not a place until it names a world — the same numbers are somewhere different on
 * every server and in every dimension — and once a plan names its server, only agents there can be
 * given a job of it. Empty is "not said yet", which the API takes as clearing it.
 */
const server = ref('')
const dimension = ref('')
const rotation = ref<Quarter>(0)

/** Servers worth offering: every one an agent is on, and whatever the plan already names. */
const servers = computed(() => {
  const known = new Set(agentStore.agents.map((agent) => agent.serverAddress).filter((address): address is string => !!address))
  if (server.value) known.add(server.value)
  return [...known].sort()
})

/** The three worlds every server has, and the plan's own if it names another. */
const dimensions = computed(() => {
  const known = new Set<string>(DIMENSIONS)
  if (dimension.value) known.add(dimension.value)
  return [...known]
})

/**
 * A rule as the fields hold it, where an empty replacement means "place nothing".
 *
 * The API says that with null. Text inputs cannot hold null, so the conversion happens at both
 * edges rather than leaving a value that is sometimes one and sometimes the other depending on
 * whether anybody has typed in it yet.
 */
interface DraftRule {
  from: string
  to: string
}

const rules = ref<DraftRule[]>([])

/** The draft as the rest of the app understands it: empty replacement becomes null. */
const asSubstitutions = computed<Substitution[]>(() =>
  rules.value
    .filter((rule) => rule.from.trim())
    .map((rule) => ({ from: rule.from.trim(), to: rule.to.trim() || null })),
)

const selected = computed(() => plans.value.find((plan) => plan.id === selectedId.value) ?? null)

const mine = computed(() => plans.value.filter((plan) => plan.schematicId === props.schematicId))

/**
 * All three or none: two coordinates do not describe a position.
 *
 * Tested for being an actual number rather than for not being null. A cleared `<input type=number>`
 * hands `v-model.number` back the **empty string**, not null — `parseFloat('')` is NaN, so the
 * modifier keeps what it was given — and an empty string is not null, so a half-cleared placement
 * used to pass this check and go up the wire. Jackson coerces `""` to null on the way in and then
 * refuses to put null in an `Int`, which is the `Cannot coerce null to int value` that came back.
 */
const placement = computed(() => {
  const { x, y, z } = place.value
  const filled = [x, y, z].every((value) => typeof value === 'number' && Number.isFinite(value))
  return filled ? { x: x as number, y: y as number, z: z as number } : null
})

/**
 * Whether the fields say something the stored plan does not.
 *
 * Without it there was no way to tell an edited plan from a saved one: the button reads the same
 * before and after, the coordinates read the same, and the material list beside them was already
 * showing the unsaved draft. The only honest response to that was to press Save again.
 *
 * Compared as the API sees it, not field by field, so whitespace and the empty-means-omit
 * conversion cannot make an unchanged plan look edited. A plan that does not exist yet is dirty as
 * soon as anything has been typed, which is what makes Create appear for a reason.
 *
 * **Declared after [placement], and it has to be.** `watch` evaluates its source once at setup to
 * take a baseline, so the getter below runs during setup rather than lazily like an unwatched
 * computed — and reading a `const` declared further down the file throws on its temporal dead zone.
 */
const dirty = computed(() => {
  const stored = selected.value
  if (!stored) {
    return (
      placement.value !== null ||
      asSubstitutions.value.length > 0 ||
      server.value !== '' ||
      dimension.value !== '' ||
      rotation.value !== 0
    )
  }

  const wasPlaced = stored.placement
    ? { x: stored.placement.x, y: stored.placement.y, z: stored.placement.z }
    : null

  return (
    JSON.stringify(placement.value) !== JSON.stringify(wasPlaced) ||
    !sameSubstitutions(asSubstitutions.value, stored.substitutions) ||
    server.value !== (stored.serverAddress ?? '') ||
    dimension.value !== (stored.dimension ? worldId(stored.dimension) : '') ||
    rotation.value !== quarterOf(stored.rotation)
  )
})

// The confirmation is about a particular set of values, so the moment they move again it is no
// longer true. Anything else leaves "Saved" sitting under a plan that has since been edited.
watch(dirty, (changed) => {
  if (changed) saved.value = null
})

const offset = computed(() => (placement.value ? offsetOf(placement.value, props.origin) : null))

const planned = computed(() => plannedMaterials(props.materials, asSubstitutions.value))
const placing = computed(() => blocksToPlace(planned.value))
const omitted = computed(() => planned.value.filter((entry) => entry.omitted))

/**
 * Blocks in the file that no rule has claimed, offered as the next substitution to add.
 *
 * Compared on the bare id: the file says `minecraft:stone` and the picker stores `stone`, so a
 * plain string compare kept offering a block that already had a rule.
 */
const unruled = computed(() => {
  const taken = new Set(rules.value.map((rule) => blockId(rule.from)))
  return props.materials.filter((material) => !taken.has(blockId(material.name)))
})

onMounted(load)

watch(() => props.schematicId, load)

async function load() {
  error.value = null
  try {
    plans.value = await listBuilds()
    choose(mine.value[0]?.id ?? null)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.generic')
  }
}

function choose(id: number | null) {
  selectedId.value = id
  saved.value = null
  const plan = plans.value.find((entry) => entry.id === id) ?? null

  place.value = plan?.placement
    ? { x: plan.placement.x, y: plan.placement.y, z: plan.placement.z }
    : { x: null, y: null, z: null }
  rules.value = (plan?.substitutions ?? []).map((rule) => ({ from: rule.from, to: rule.to ?? '' }))
  server.value = plan?.serverAddress ?? ''
  dimension.value = plan?.dimension ? worldId(plan.dimension) : ''
  rotation.value = quarterOf(plan?.rotation)

  emit('planned', plan)
}

function addRule() {
  // Seeded with a block that is actually in the file and not already ruled on, because that is
  // always what a new rule is about — but it stays editable, and the picker is how it is changed.
  rules.value = [...rules.value, { from: unruled.value[0]?.name ?? '', to: '' }]
}

async function save() {
  busy.value = true
  error.value = null

  const substitutions = asSubstitutions.value

  try {
    // Empty strings rather than omitted: blank is how the API is told to take a server or a world
    // back off a plan, and omitting them would leave whatever was there.
    const world = { serverAddress: server.value, dimension: dimension.value, rotation: rotation.value }

    const plan = selected.value
      ? await updateBuild(selected.value.id, {
          substitutions,
          ...world,
          ...(placement.value ? { placement: placement.value } : { unplace: true }),
        })
      : await createBuild({
          name: nextName(),
          schematicId: props.schematicId,
          placement: placement.value,
          substitutions,
          ...world,
        })

    plans.value = [plan, ...plans.value.filter((entry) => entry.id !== plan.id)]
    selectedId.value = plan.id
    // Named rather than a bare tick: several plans can exist for one schematic, and "Saved" alone
    // does not say which of them the operator has just written to.
    saved.value = t('builds.savedAs', { name: plan.name })
    emit('planned', plan)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.generic')
  } finally {
    busy.value = false
  }
}

/** Named after the schematic, numbered when that name is taken. Renaming is the operator's. */
function nextName(): string {
  const used = new Set(plans.value.map((plan) => plan.name))
  if (!used.has(props.schematicName)) return props.schematicName

  let suffix = 2
  while (used.has(`${props.schematicName} ${suffix}`)) suffix += 1
  return `${props.schematicName} ${suffix}`
}

/** The empty option is the plan being written, which has no id yet. */
function pickedId(event: Event): number | null {
  const value = (event.target as HTMLSelectElement).value
  return value === '' ? null : Number(value)
}

/**
 * Renaming and deleting a plan, both of which the API has always supported.
 *
 * `deleteBuild` was exported and called from nowhere, and `updateBuild` took a `name` no control
 * ever set — under a comment saying "renaming is the operator's". It was not: there was nothing to
 * rename it with, and no way to reach a second plan to need distinguishing in the first place.
 */
const renameDialog = ref<InstanceType<typeof ModalShell> | null>(null)
const removeDialog = ref<InstanceType<typeof ModalShell> | null>(null)
const nameDraft = ref('')

function openRename() {
  if (!selected.value) return
  nameDraft.value = selected.value.name
  error.value = null
  renameDialog.value?.showModal()
}

async function saveName() {
  const plan = selected.value
  if (!plan || busy.value || !nameDraft.value.trim()) return

  busy.value = true
  error.value = null
  try {
    const renamed = await updateBuild(plan.id, { name: nameDraft.value.trim() })
    plans.value = plans.value.map((entry) => (entry.id === renamed.id ? renamed : entry))
    renameDialog.value?.close()
    emit('planned', renamed)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.generic')
  } finally {
    busy.value = false
  }
}

async function removePlan() {
  const plan = selected.value
  if (!plan || busy.value) return

  busy.value = true
  error.value = null
  try {
    await deleteBuild(plan.id)
    plans.value = plans.value.filter((entry) => entry.id !== plan.id)
    removeDialog.value?.close()
    // Onto whatever is left for this schematic, or to a blank draft when nothing is.
    choose(mine.value[0]?.id ?? null)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.generic')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[26rem_1fr]">
    <div class="card border-base-300 bg-base-200 h-fit border">
      <div class="card-body gap-4">
        <h2 class="card-title text-base">{{ t('builds.title') }}</h2>

        <!--
          Several plans for one schematic is the reason a plan is its own thing: the same building
          goes up on two servers, or twice on one at different coordinates.

          The selector used to be the only control here and could never appear — `load` always chose
          the first plan and nothing ever cleared that, so once one existed the panel was locked to
          it and `mine.length > 1` stayed false forever. It shows from the first plan now, because
          the row beside it is how a second one gets made.
        -->
        <div v-if="mine.length" class="form-control">
          <span class="label-text text-xs opacity-60">{{ t('builds.whichPlan') }}</span>
          <div class="mt-1 flex items-center gap-1">
            <select
              class="select select-sm min-w-0 flex-1"
              :value="selectedId ?? ''"
              @change="choose(pickedId($event))"
            >
              <option v-for="plan in mine" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
              <!-- The unsaved plan is in the list while it is being written, so the control never
                   claims the operator is editing something they are not. -->
              <option v-if="selectedId === null" value="">{{ t('builds.newPlanOption') }}</option>
            </select>

            <template v-if="auth.can('schematic.write')">
              <button
                type="button"
                class="btn btn-ghost btn-sm shrink-0 px-2"
                :title="t('builds.newPlan')"
                :disabled="selectedId === null"
                @click="choose(null)"
              >
                <Plus class="size-4" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm shrink-0 px-2"
                :title="t('builds.rename')"
                :disabled="!selected"
                @click="openRename"
              >
                <SquarePen class="size-4" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm shrink-0 px-2"
                :title="t('builds.removePlan')"
                :disabled="!selected"
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
            {{ t('builds.placement') }}
          </p>
          <p class="mt-1 text-xs opacity-60">{{ t('builds.placementHint') }}</p>

          <div class="mt-3 grid grid-cols-3 gap-2">
            <label v-for="axis in (['x', 'y', 'z'] as const)" :key="axis" class="form-control">
              <span class="label-text text-xs uppercase opacity-50">{{ axis }}</span>
              <!--
                `autocomplete` and a name of its own, because a bare numeric box one character
                wide is exactly what a browser decides must be a phone number. Chrome guesses from
                the name, the label and the surrounding fields, and three unnamed number inputs in
                a row look enough like an address block that it offers to fill them from the
                profile. An unrecognised token turns the guessing off where a plain `off` is
                ignored.
              -->
              <input
                v-model.number="place[axis]"
                type="number"
                :name="`placement-${axis}`"
                autocomplete="off"
                data-1p-ignore
                data-lpignore="true"
                class="input input-sm w-full tabular-nums"
                :disabled="!auth.can('schematic.write')"
              />
            </label>
          </div>

          <p v-if="offset" class="mt-2 text-xs opacity-50">
            {{ t('builds.offsetBy', { x: offset.x, y: offset.y, z: offset.z }) }}
          </p>
          <p v-else class="mt-2 text-xs opacity-50">{{ t('builds.unplaced') }}</p>

          <!--
            The world the coordinates are in. A select rather than free text for the server: the
            address has to match what agents report, character for character, or no agent is ever
            eligible — and the ones agents report are the ones on offer.
          -->
          <div class="mt-3 grid grid-cols-2 gap-2">
            <label class="form-control min-w-0">
              <span class="label-text text-xs opacity-50">{{ t('builds.server') }}</span>
              <select v-model="server" class="select select-sm w-full" :disabled="!auth.can('schematic.write')">
                <option value="">{{ t('builds.anyServer') }}</option>
                <option v-for="address in servers" :key="address" :value="address">{{ address }}</option>
              </select>
            </label>
            <label class="form-control min-w-0">
              <span class="label-text text-xs opacity-50">{{ t('builds.dimension') }}</span>
              <select v-model="dimension" class="select select-sm w-full" :disabled="!auth.can('schematic.write')">
                <option value="">{{ t('builds.anyDimension') }}</option>
                <option v-for="world in dimensions" :key="world" :value="world">{{ dimensionLabel(world) }}</option>
              </select>
            </label>
          </div>
          <p class="mt-1 text-xs opacity-50">{{ t('builds.serverHint') }}</p>

          <div class="mt-3">
            <span class="label-text flex items-center gap-1 text-xs opacity-50">
              <RotateCw class="size-3" />
              {{ t('builds.rotation') }}
            </span>
            <div class="join mt-1" role="radiogroup" :aria-label="t('builds.rotation')">
              <button
                v-for="turn in QUARTERS"
                :key="turn"
                type="button"
                role="radio"
                :aria-checked="rotation === turn"
                class="btn btn-sm join-item tabular-nums"
                :class="rotation === turn ? 'btn-primary' : 'btn-ghost border-base-300'"
                :disabled="!auth.can('schematic.write')"
                @click="rotation = turn"
              >
                {{ turn }}°
              </button>
            </div>
            <p class="mt-1 text-xs opacity-50">{{ t('builds.rotationHint') }}</p>
          </div>
        </div>

        <div class="border-base-300 border-t pt-4">
          <p class="flex items-center gap-2 text-sm font-medium">
            <Replace class="text-base-content/50 size-4" />
            {{ t('builds.substitutions') }}
          </p>
          <p class="mt-1 text-xs opacity-60">{{ t('builds.substitutionsHint') }}</p>

          <ul class="mt-3 flex flex-col gap-2">
            <!--
              Stacked rather than side by side. Two pickers sharing one column left each about
              150px, which is not enough for a block name, its id and a swatch — and the suggestion
              list is only as wide as the field it hangs off. A rule is two lines and reads down.
            -->
            <li
              v-for="(rule, index) in rules"
              :key="index"
              class="border-base-300 flex flex-col gap-1 rounded-box border p-2"
            >
              <div class="flex items-center gap-1">
                <!-- The source is a block that is actually in the file, so those are offered first. -->
                <BlockPicker
                  v-model="rule.from"
                  size="xs"
                  class="min-w-0 flex-1"
                  :prefer="props.materials.map((material) => material.name)"
                />
                <button
                  type="button"
                  class="btn btn-ghost btn-xs shrink-0 px-1"
                  :title="t('common.delete')"
                  @click="rules = rules.filter((_, at) => at !== index)"
                >
                  <Trash2 class="size-3.5" />
                </button>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="shrink-0 ps-1 text-xs opacity-50">→</span>
                <!-- Left empty on purpose means "place nothing", which the placeholder says. -->
                <BlockPicker
                  v-model="rule.to"
                  size="xs"
                  class="min-w-0 flex-1"
                  :placeholder="t('builds.placeNothing')"
                />
              </div>
            </li>
          </ul>

          <button
            type="button"
            class="btn btn-ghost btn-xs mt-2 gap-1"
            :disabled="!unruled.length"
            @click="addRule"
          >
            <Plus class="size-3.5" />
            {{ t('builds.addSubstitution') }}
          </button>
        </div>

        <AlertNote v-if="error" kind="error" class="text-sm" :message="error" />

        <!--
          Which of the two is showing is the answer to "did that go through". The same shape
          Configuration uses, for the same reason: a save that reports nothing is indistinguishable
          from a button that does nothing.
        -->
        <div v-if="auth.can('schematic.write')" class="flex items-center gap-2">
          <span v-if="dirty" class="text-warning text-xs">{{ t('builds.unsaved') }}</span>
          <span v-else-if="saved" class="text-success flex items-center gap-1 text-xs">
            <Check class="size-3.5" />
            {{ saved }}
          </span>

          <button
            type="button"
            class="btn btn-primary btn-sm ml-auto"
            :disabled="busy || !dirty"
            @click="save"
          >
            {{ busy ? t('builds.saving') : selected ? t('builds.save') : t('builds.createPlan') }}
          </button>
        </div>
      </div>
    </div>

    <!--
      What the plan comes to. Substituted blocks merge into one pile, because somebody counting out
      chests wants one number for stone rather than three lines to add up; blocks replaced by
      nothing stay on the list and are marked, because what is being left out is exactly what an
      operator wants to see before agreeing to it.
    -->
    <div class="card border-base-300 bg-base-200 h-fit border">
      <div class="card-body gap-4">
        <h2 class="card-title text-base">{{ t('builds.asBuilt') }}</h2>

        <div class="stats stats-horizontal border-base-300 border">
          <div class="stat px-4 py-3">
            <div class="stat-title text-xs">{{ t('builds.blocksPlaced') }}</div>
            <div class="stat-value text-xl">{{ n(placing) }}</div>
          </div>
          <div v-if="omitted.length" class="stat px-4 py-3">
            <div class="stat-title text-xs">{{ t('builds.leftOut') }}</div>
            <div class="stat-value text-warning text-xl">
              {{ n(omitted.reduce((total, entry) => total + entry.blocks, 0)) }}
            </div>
          </div>
        </div>

        <p v-if="!planned.length" class="text-sm opacity-60">{{ t('schematics.noMaterials') }}</p>

        <ul v-else class="divide-base-300 max-h-96 divide-y overflow-y-auto text-sm">
          <li
            v-for="entry in planned"
            :key="entry.name + (entry.omitted ? ' omitted' : '')"
            class="flex items-center justify-between gap-3 py-1.5"
          >
            <span
              class="border-base-content/20 mt-0.5 size-3.5 shrink-0 rounded-[3px] border"
              :style="{ background: blockColour(entry.name) }"
            ></span>
            <span class="min-w-0 flex-1">
              <span :class="entry.omitted ? 'line-through opacity-50' : 'opacity-80'">
                {{ blockName(entry.name) }}
              </span>
              <span v-if="entry.substitutedFrom" class="block text-xs opacity-50">
                {{
                  entry.omitted
                    ? t('builds.omittedFrom')
                    : t('builds.mergedFrom', {
                        from: entry.substitutedFrom.map(blockName).join(', '),
                      })
                }}
              </span>
            </span>
            <span class="shrink-0 tabular-nums" :class="entry.omitted ? 'text-warning' : 'opacity-60'">
              {{ n(entry.blocks) }}
            </span>
          </li>
        </ul>
      </div>
    </div>

    <ModalShell ref="renameDialog" :title="t('builds.renameTitle')" :icon="SquarePen">
      <p class="mt-1 text-sm opacity-60">{{ t('builds.renameHint') }}</p>
      <form class="mt-5 flex flex-col gap-4" @submit.prevent="saveName">
        <FormField
          v-model="nameDraft"
          :label="t('builds.planName')"
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

    <!-- Asked for like every other destructive act, and it names which plan: the whole point of
         this row is that there can be more than one. -->
    <ModalShell
      ref="removeDialog"
      :title="t('builds.removeTitle', { name: selected?.name ?? '' })"
      :icon="Trash2"
      tone="error"
    >
      <p class="mt-3 text-sm opacity-70">{{ t('builds.removeWarning') }}</p>
      <div class="modal-action">
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="busy"
          @click="removeDialog?.close()"
        >
          {{ t('common.cancel') }}
        </button>
        <button class="btn btn-error btn-sm gap-2" type="button" :disabled="busy" @click="removePlan">
          <Trash2 class="size-4" />
          {{ busy ? t('common.deleting') : t('builds.removePlan') }}
        </button>
      </div>
    </ModalShell>
  </div>
</template>
