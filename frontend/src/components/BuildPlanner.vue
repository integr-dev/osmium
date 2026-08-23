<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MapPin, Plus, Replace, Trash2, TriangleAlert } from 'lucide-vue-next'
import {
  createBuild,
  listBuilds,
  updateBuild,
  type BuildResponse,
} from '../api/builds'
import BlockPicker from './BlockPicker.vue'
import { blockColour } from '../lib/blockColours'
import { blockName } from '../lib/blockNames'
import { blocksToPlace, offsetOf, plannedMaterials, type Substitution } from '../lib/placement'
import type { Vec3 } from '../lib/box3d'
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

const plans = ref<BuildResponse[]>([])
const selectedId = ref<number | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

/** The draft, which is what the fields edit. Committed to the plan only when saved. */
const place = ref<{ x: number | null; y: number | null; z: number | null }>({ x: null, y: null, z: null })

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

/** All three or none: two coordinates do not describe a position. */
const placement = computed(() => {
  const { x, y, z } = place.value
  return x !== null && y !== null && z !== null ? { x, y, z } : null
})

const offset = computed(() => (placement.value ? offsetOf(placement.value, props.origin) : null))

const planned = computed(() => plannedMaterials(props.materials, asSubstitutions.value))
const placing = computed(() => blocksToPlace(planned.value))
const omitted = computed(() => planned.value.filter((entry) => entry.omitted))

/** Blocks in the file that no rule has claimed, offered as the next substitution to add. */
const unruled = computed(() => {
  const taken = new Set(rules.value.map((rule) => rule.from))
  return props.materials.filter((material) => !taken.has(material.name))
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
  const plan = plans.value.find((entry) => entry.id === id) ?? null

  place.value = plan?.placement
    ? { x: plan.placement.x, y: plan.placement.y, z: plan.placement.z }
    : { x: null, y: null, z: null }
  rules.value = (plan?.substitutions ?? []).map((rule) => ({ from: rule.from, to: rule.to ?? '' }))

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
    const plan = selected.value
      ? await updateBuild(selected.value.id, {
          substitutions,
          ...(placement.value ? { placement: placement.value } : { unplace: true }),
        })
      : await createBuild({
          name: nextName(),
          schematicId: props.schematicId,
          placement: placement.value,
          substitutions,
        })

    plans.value = [plan, ...plans.value.filter((entry) => entry.id !== plan.id)]
    selectedId.value = plan.id
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
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[26rem_1fr]">
    <div class="card border-base-300 bg-base-200 h-fit border">
      <div class="card-body gap-4">
        <h2 class="card-title text-base">{{ t('builds.title') }}</h2>

        <!-- Several plans for one schematic is the reason a plan is its own thing: the same
             building goes up on two servers, or twice on one at different coordinates. -->
        <label v-if="mine.length > 1" class="form-control">
          <span class="label-text text-xs opacity-60">{{ t('builds.whichPlan') }}</span>
          <select
            class="select select-sm w-full"
            :value="selectedId"
            @change="choose(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="plan in mine" :key="plan.id" :value="plan.id">{{ plan.name }}</option>
          </select>
        </label>

        <div>
          <p class="flex items-center gap-2 text-sm font-medium">
            <MapPin class="text-primary size-4" />
            {{ t('builds.placement') }}
          </p>
          <p class="mt-1 text-xs opacity-60">{{ t('builds.placementHint') }}</p>

          <div class="mt-3 grid grid-cols-3 gap-2">
            <label v-for="axis in (['x', 'y', 'z'] as const)" :key="axis" class="form-control">
              <span class="label-text text-xs uppercase opacity-50">{{ axis }}</span>
              <input
                v-model.number="place[axis]"
                type="number"
                class="input input-sm w-full tabular-nums"
                :disabled="!auth.can('schematic.write')"
              />
            </label>
          </div>

          <p v-if="offset" class="mt-2 text-xs opacity-50">
            {{ t('builds.offsetBy', { x: offset.x, y: offset.y, z: offset.z }) }}
          </p>
          <p v-else class="mt-2 text-xs opacity-50">{{ t('builds.unplaced') }}</p>
        </div>

        <div class="border-base-300 border-t pt-4">
          <p class="flex items-center gap-2 text-sm font-medium">
            <Replace class="text-primary size-4" />
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
              class="border-base-300 flex flex-col gap-1 rounded-lg border p-2"
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
                <span class="shrink-0 ps-1 text-xs opacity-40">→</span>
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

        <div v-if="error" role="alert" class="alert alert-error alert-soft text-sm">
          <TriangleAlert class="size-4" />
          <span>{{ error }}</span>
        </div>

        <button
          v-if="auth.can('schematic.write')"
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="busy"
          @click="save"
        >
          {{ selected ? t('builds.save') : t('builds.createPlan') }}
        </button>
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
  </div>
</template>
