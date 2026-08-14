<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, RotateCcw, SlidersHorizontal, TriangleAlert } from 'lucide-vue-next'
import {
  loadSettings,
  optionLabel,
  saveSettings,
  settingLabel,
  SETTING_GROUPS,
  type AgentSettings,
} from '../lib/configuration'
import AgentPicker from '../components/AgentPicker.vue'
import { useAgentStore } from '../stores/agents'

/**
 * Remote configuration: pick agents on the left, edit on the right.
 *
 * **The settings themselves are mock** — see `src/lib/configuration.ts`. The screen is real so the
 * interaction can be argued about before the wire format is settled; nothing here reaches a host.
 *
 * The fields render from a declared schema rather than from markup per setting, so adding one is an
 * entry in that file and a copy key. That is the part meant to survive the mock.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

const selected = ref<number[]>([])
const settings = ref<AgentSettings | null>(null)
const original = ref<AgentSettings | null>(null)
const busy = ref(false)
const saved = ref<string | null>(null)

/**
 * The form is seeded from the **first agent checked**, and pushed to every agent checked.
 *
 * Two agents can hold different values for one field and there is no honest way to show both in a
 * single input, so one of them has to be the source. Taking the first selection makes that visible
 * and controllable — it is named above the fields, and unchecking it hands the role to the next.
 */
const primary = computed(() => agentStore.byId(selected.value[0]))
const targets = computed(() => selected.value.map((id) => agentStore.byId(id)).filter((a) => a !== undefined))

const dirty = computed(
  () =>
    settings.value !== null &&
    original.value !== null &&
    JSON.stringify(settings.value) !== JSON.stringify(original.value),
)

onMounted(() => {
  // Reachable by deep link, where the sidebar has not loaded the fleet yet.
  if (!agentStore.agents.length) void agentStore.refresh()
})

/**
 * Keyed on the id rather than the agent, so adding a second selection does not reload the form and
 * throw away what has been typed — only a change of *source* does that.
 */
watch(
  () => primary.value?.id,
  async (id) => {
    saved.value = null
    if (id === undefined) {
      settings.value = null
      original.value = null
      return
    }
    const loaded = await loadSettings(id)
    settings.value = loaded
    original.value = { ...loaded }
  },
  { immediate: true },
)

function reset() {
  if (original.value) settings.value = { ...original.value }
  saved.value = null
}

async function update() {
  const applyTo = targets.value
  if (!applyTo.length || !settings.value) return

  busy.value = true
  try {
    await Promise.all(applyTo.map((agent) => saveSettings(agent.id, settings.value as AgentSettings)))
    original.value = { ...settings.value }
    saved.value =
      applyTo.length === 1
        ? t('configuration.updated', { name: applyTo[0].label })
        : t('configuration.updatedMany', { count: applyTo.length })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('configuration.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('configuration.subtitle') }}</p>
    </header>

    <div role="alert" class="alert alert-warning alert-soft">
      <TriangleAlert class="size-4" />
      <span>{{ t('configuration.mock') }}</span>
    </div>

    <div class="grid gap-6 lg:grid-cols-[20rem_1fr]">
      <!-- Left: who to configure. Shared with Operations, so the two cannot drift apart. -->
      <AgentPicker v-model="selected" :agents="agentStore.agents" />

      <!-- Right: what to set. -->
      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-4">
          <!--
            Centred, not baseline-aligned: the badge carries its own padding and line height, so
            sitting it on the text baseline puts the box itself off by a few pixels.
          -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 class="card-title flex items-center gap-2 text-base">
              <SlidersHorizontal class="text-primary size-4" />
              {{ t('configuration.title') }}
            </h2>
            <!--
              Which agent the values came from is stated, not implied. Editing one agent's settings
              and pushing them to five is only safe if it is obvious whose they were.
            -->
            <span v-if="primary" class="text-xs opacity-60">
              {{ t('configuration.valuesFrom', { name: primary.label }) }}
            </span>
            <span v-if="targets.length > 1" class="badge badge-warning badge-soft badge-sm ml-auto">
              {{ t('configuration.appliesTo', { count: targets.length }, targets.length) }}
            </span>
          </div>

          <p v-if="!primary" class="py-10 text-center text-sm opacity-50">
            {{ t('configuration.pickOne') }}
          </p>

          <!--
            The form's shape is fixed and known before its values are, so the fields stand in for
            themselves. A spinner here would collapse the panel and then push the page back open.
          -->
          <div v-else-if="!settings" class="flex flex-col gap-6">
            <div v-for="group in SETTING_GROUPS" :key="group.key" class="flex flex-col gap-3">
              <div class="skeleton h-3 w-24"></div>
              <div v-for="field in group.fields" :key="field.key" class="flex items-center justify-between">
                <div class="skeleton h-4 w-44"></div>
                <div class="skeleton h-8 w-32"></div>
              </div>
            </div>
          </div>

          <template v-else-if="settings">
            <div v-for="group in SETTING_GROUPS" :key="group.key" class="flex flex-col gap-3">
              <h3 class="text-xs font-semibold tracking-wide uppercase opacity-50">
                {{ t(`configuration.group.${group.key}`) }}
              </h3>

              <div
                v-for="field in group.fields"
                :key="field.key"
                class="flex items-center justify-between gap-4"
              >
                <span class="text-sm">{{ settingLabel(field.key) }}</span>

                <input
                  v-if="field.type === 'toggle'"
                  v-model="settings[field.key] as boolean"
                  type="checkbox"
                  class="toggle toggle-sm toggle-primary"
                />

                <label v-else-if="field.type === 'number'" class="input input-sm w-32">
                  <input v-model.number="settings[field.key] as number" type="number" :min="field.min" :max="field.max" />
                  <span v-if="field.unit" class="text-xs opacity-50">{{ field.unit }}</span>
                </label>

                <select
                  v-else
                  v-model="settings[field.key] as string"
                  class="select select-sm w-44"
                >
                  <option v-for="option in field.options" :key="option" :value="option">
                    {{ optionLabel(field.key, option) }}
                  </option>
                </select>
              </div>
            </div>

            <div class="border-base-300 flex items-center gap-3 border-t pt-4">
              <span v-if="dirty" class="text-warning text-xs">{{ t('configuration.unsaved') }}</span>
              <span v-else-if="saved" class="text-success flex items-center gap-1 text-xs">
                <Check class="size-3.5" />
                {{ saved }}
              </span>

              <button
                v-if="dirty"
                type="button"
                class="btn btn-ghost btn-sm ml-auto gap-2"
                @click="reset"
              >
                <RotateCcw class="size-4" />
                {{ t('configuration.reset') }}
              </button>

              <!--
                Enabled with several selected even when nothing was edited: copying one agent's
                configuration onto others is the point of a multi-selection, and requiring a
                pointless edit first would be a rule with no reason behind it.
              -->
              <button
                type="button"
                class="btn btn-primary btn-sm gap-2"
                :class="dirty ? '' : 'ml-auto'"
                :disabled="busy || (!dirty && targets.length < 2)"
                @click="update"
              >
                <SlidersHorizontal class="size-4" />
                {{ busy ? t('configuration.updating') : t('configuration.update') }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
