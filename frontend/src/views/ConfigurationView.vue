<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component, type WritableComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Blocks, Check, MessageSquare, Plug, RotateCcw, SlidersHorizontal } from 'lucide-vue-next'
import {
  groupLabel,
  optionLabel,
  saveSettings,
  settingHint,
  settingLabel,
  settingsOf,
  SETTING_GROUPS,
  type AgentSettings,
} from '../lib/configuration'
import AgentPicker from '../components/AgentPicker.vue'
import RegexField from '../components/RegexField.vue'
import SwapBox from '../components/SwapBox.vue'
import TabBar, { type Tab as Strip } from '../components/TabBar.vue'
import { useSlide } from '../lib/motion'
import { useQueryTab } from '../lib/queryState'
import { useAgentStore } from '../stores/agents'

/**
 * Remote configuration: pick agents on the left, edit on the right.
 *
 * The settings are declared in `src/lib/configuration.ts`. The backend stores the map and relays it
 * to the host without interpreting anything — `connect.rejoin` aside — and a host applies the keys
 * it recognises, so a new setting is an entry in that file plus the code that reads it, rather than
 * a release on three sides in order.
 *
 * The fields render from that schema rather than from markup per setting, and so do the tabs: a
 * group in that file is a tab here, and adding one needs nothing in this view.
 */
const { t } = useI18n()
const agentStore = useAgentStore()

/**
 * One tab per group, because a chat pattern and a reconnect policy are not read in the same sitting.
 *
 * **The form is still one form.** Every tab edits the same map and Update sends the whole of it, so
 * moving between them loses nothing and there is no per-tab save to get out of step. The tabs are
 * about how much is on screen at once, and nothing else.
 *
 * The icons live here rather than in the schema: which glyph reads as "chat" is a question about
 * this view, and the settings file has no business importing components. A group without one simply
 * gets no icon.
 */
const ICONS: Record<string, Component> = {
  chat: MessageSquare,
  mc: Blocks,
  connect: Plug,
}

const TABS: readonly string[] = SETTING_GROUPS.map((group) => group.key)

/** In the query string, so a link can point at a tab and Back walks the tabs the operator opened. */
const tab = useQueryTab<string>('tab', TABS, TABS[0] ?? '')

const slide = useSlide(tab, TABS)

const strip = computed<Strip<string>[]>(() =>
  SETTING_GROUPS.map((group) => ({
    id: group.key,
    label: t(groupLabel(group.key)),
    icon: ICONS[group.key],
  })),
)

/**
 * The group on screen, or nothing when the query names one this build does not have.
 *
 * Undefined rather than falling back to the first: `useQueryTab` already narrows to the known set,
 * so the only way here is a schema that changed under a stale reference — and drawing the wrong
 * group's fields under the right group's tab would be worse than drawing none.
 */
const active = computed(() => SETTING_GROUPS.find((group) => group.key === tab.value))

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

/**
 * Boolean views onto the switch settings, since every setting is a string and a checkbox is not.
 *
 * **Off is `''`, not `'false'`.** An absent key is what both the backend and a host already read as
 * "no", so writing the word would give "turned off" and "never touched" two spellings of one answer
 * — and `saveSettings` strips the empty one on the way out regardless. A setting where off and unset
 * genuinely differ is a `choice` with three options instead, which is what `mc.knockback` is.
 *
 * Built once rather than derived from the current values: the schema is static, and rebuilding the
 * map on every keystroke would hand the checkboxes a new binding each time.
 */
const switches: Record<string, WritableComputedRef<boolean>> = Object.fromEntries(
  SETTING_GROUPS.flatMap((group) => group.fields)
    .filter((field) => field.type === 'switch')
    .map((field) => [
      field.key,
      computed({
        get: () => settings.value?.[field.key] === 'true',
        set: (on: boolean) => {
          if (settings.value) settings.value[field.key] = on ? 'true' : ''
        },
      }),
    ]),
)

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
  (id) => {
    saved.value = null
    if (id === undefined) {
      settings.value = null
      original.value = null
      return
    }
    const loaded = settingsOf(primary.value)
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
  <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('configuration.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('configuration.subtitle') }}</p>
    </header>

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
          <div v-else-if="!settings" class="flex flex-col gap-4">
            <div class="skeleton h-8 w-64"></div>
            <div v-for="field in active?.fields ?? []" :key="field.key" class="flex flex-col gap-1.5">
              <div class="skeleton h-4 w-44"></div>
              <div class="skeleton h-8 w-full max-w-xs"></div>
            </div>
          </div>

          <template v-else-if="settings">
            <TabBar v-model="tab" :tabs="strip" size="sm" />

            <!--
              The groups hold different numbers of fields, so the card would jump between two heights
              as the panels crossed. SwapBox measures what is arriving and eases the frame to it.
            -->
            <!--
              The padding is for the focus ring, not for looks. Both SwapBox and the slide frame
              inside it clip horizontally, so that a panel arriving from the side is not visible past
              the edge of the card - and a focused field's outline sits 4px outside its own box, so
              it was being cut off against those same edges. The panel carries the room for it and
              the frame gives back the width, which leaves every field aligned with the tabs above.
            -->
            <SwapBox class="-mx-1.5">
              <Transition :name="slide">
                <div :key="tab" class="flex flex-col gap-3 px-1.5">
                  <!--
                    Stacked rather than in a row: a pattern is a line of code, and it needs the width of
                    the panel plus room underneath for what it reads out of a sample line.
                  -->
                  <div v-for="field in active?.fields ?? []" :key="field.key" class="flex flex-col gap-1.5">
                    <!--
                      A switch sits beside its label rather than under it: the control is the width of a
                      thumb, and a whole row of empty space between the two reads as a missing field.
                    -->
                    <label
                      v-if="field.type === 'switch'"
                      class="flex cursor-pointer items-start gap-3"
                    >
                      <input
                        v-model="switches[field.key].value"
                        type="checkbox"
                        class="toggle toggle-primary toggle-sm mt-0.5"
                      />
                      <span class="flex flex-col gap-1.5">
                        <span class="text-sm">{{ t(settingLabel(field.key)) }}</span>
                        <span class="text-xs opacity-60">{{ t(settingHint(field.key)) }}</span>
                      </span>
                    </label>

                    <template v-else>
                      <span class="text-sm">{{ t(settingLabel(field.key)) }}</span>
                      <span class="text-xs opacity-60">{{ t(settingHint(field.key)) }}</span>

                      <RegexField
                        v-if="field.type === 'regex'"
                        v-model="settings[field.key] as string"
                        :default="field.default"
                        :sample="field.sample"
                        :placeholder="field.default"
                      />

                      <select
                        v-else-if="field.type === 'choice'"
                        v-model="settings[field.key]"
                        class="select select-sm w-full max-w-xs"
                      >
                        <option v-for="value in field.options" :key="value || 'auto'" :value="value">
                          {{ t(optionLabel(field.key, value)) }}
                        </option>
                      </select>

                      <input
                        v-else
                        v-model="settings[field.key]"
                        type="text"
                        class="input input-sm w-full max-w-xs font-mono"
                        :placeholder="field.placeholder"
                        spellcheck="false"
                        autocomplete="off"
                      />
                    </template>
                  </div>
                </div>
              </Transition>
            </SwapBox>

            <!--
              Outside the tabs on purpose. Update sends the whole map, so an operator who edited two
              groups presses one button — and a save that lived inside a tab would look like it only
              covered what was on screen.
            -->
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
