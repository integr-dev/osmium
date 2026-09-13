<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component, type WritableComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Blocks, Check, Footprints, MessageSquare, Plug, RotateCcw, SlidersHorizontal, Users, Wrench } from 'lucide-vue-next'
import {
  groupLabel,
  optionLabel,
  saveSettings,
  settingHint,
  settingLabel,
  settingsOf,
  SETTING_GROUPS,
  type AgentSettings,
  type SettingField,
  rangeEnd,
} from '../lib/configuration'
import AgentPicker from '../components/AgentPicker.vue'
import PlayerListField from '../components/PlayerListField.vue'
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
 * **Update sends the tab on screen, and only that tab.** Each agent keeps everything it already had
 * and gets the fields in front of the operator — which is also what stops a bulk apply from carrying
 * one server's chat patterns onto agents playing somewhere else. Edits left behind another tab are
 * named under the button rather than saved silently or thrown away.
 *
 * The icons live here rather than in the schema: which glyph reads as "chat" is a question about
 * this view, and the settings file has no business importing components. A group without one simply
 * gets no icon.
 */
const ICONS: Record<string, Component> = {
  chat: MessageSquare,
  mc: Blocks,
  util: Wrench,
  // The same glyph the Go button and the audit trail use, so the three places that mean
  // "movement" are recognisable as one another.
  path: Footprints,
  connect: Plug,
  players: Users,
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
 * The proxies the selected agents could be routed through.
 *
 * **Gathered from their hosts rather than declared with the setting.** A proxy is a file on a
 * machine, announced in that machine's handshake, so the list belongs to the fleet and changes when
 * a host reconnects — which is also why an empty list is shown as a sentence rather than as a picker
 * with one option in it.
 *
 * Named by the host when the selection spans more than one, because two machines may well hold
 * proxies under the same name and the value written to an agent is the name alone. A proxy that its
 * own host does not hold refuses the connection outright; the host says so in the agent's activity.
 */
const routes = computed(() => {
  const hosts = [...new Set(targets.value.map((agent) => agent.hostId))]
  const several = hosts.length > 1

  return hosts.flatMap((hostId) => {
    const host = agentStore.hostById(hostId)
    return (host?.proxies ?? []).map((proxy) => ({
      key: `${hostId}:${proxy.name}`,
      name: proxy.name,
      label: several ? t('configuration.settings.connect_proxy.onHost', { name: proxy.name, host: host?.name ?? '' }) : proxy.name,
      detail: `${proxy.kind} · ${proxy.host}:${proxy.port}`,
    }))
  })
})

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

/** Whether [fields] hold anything other than what was loaded. */
function changed(fields: readonly SettingField[]): boolean {
  const now = settings.value
  const was = original.value
  if (!now || !was) return false

  return fields.some((field) => now[field.key] !== was[field.key])
}

/**
 * The fields of this tab that are worth showing, given the rest of the form.
 *
 * Only what is drawn — `update` still sends the whole tab, hidden fields included. A field is hidden
 * because the question does not arise, not because the answer stopped counting, and dropping it from
 * the payload would clear a choice the operator made before they turned the other setting off.
 */
const showing = computed(() =>
  (active.value?.fields ?? []).filter((field) => !field.showWhen || field.showWhen(settings.value ?? {})),
)

/** The tab on screen, which is the only thing Update sends. */
const dirty = computed(() => changed(active.value?.fields ?? []))

/**
 * Tabs that hold edits Update will not send.
 *
 * Named rather than merely counted. Update applies one tab, so an operator who edited chat, moved to
 * Minecraft and pressed the button has unsaved work behind them — and the one thing worse than
 * finding that out is not finding out.
 */
const unsentElsewhere = computed(() =>
  SETTING_GROUPS.filter((group) => group.key !== tab.value && changed(group.fields)).map((group) =>
    t(groupLabel(group.key)),
  ),
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

/** Puts back what this tab was loaded with, leaving the other tabs' edits where they are. */
function reset() {
  const was = original.value
  if (!was || !settings.value) return

  for (const field of active.value?.fields ?? []) settings.value[field.key] = was[field.key] ?? ''
  saved.value = null
}

/**
 * Sends **this tab**, and only this tab.
 *
 * **Merged onto each agent's own stored settings, not onto the form's.** The endpoint takes the
 * whole set and treats an absent key as cleared, so sending the tab's keys alone would wipe every
 * other tab. Merging onto the *form* would be almost as wrong in the other direction: the form was
 * seeded from the first agent checked, so pushing it to four more would carry that agent's chat
 * patterns onto servers they were never written for — which is how two agents on two servers ended
 * up with one server's format.
 *
 * So each agent keeps everything it already had, and gets exactly the fields on screen.
 */
async function update() {
  const applyTo = targets.value
  const editing = settings.value
  const fields = active.value?.fields
  if (!applyTo.length || !editing || !fields) return

  const page = Object.fromEntries(fields.map((field) => [field.key, editing[field.key] ?? '']))

  busy.value = true
  try {
    await Promise.all(applyTo.map((agent) => saveSettings(agent.id, { ...settingsOf(agent), ...page })))

    // Only what was sent is now saved. The other tabs stay dirty, because they are.
    if (original.value) Object.assign(original.value, page)

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
            <div v-for="field in showing" :key="field.key" class="flex flex-col gap-1.5">
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
                <div
                  :key="tab"
                  class="divide-base-300/60 flex flex-col divide-y px-1.5"
                >
                  <!--
                    Every field is a label and its explanation in one left column, with the control
                    either beside it or under it. It used to depend on the type: a switch put its
                    label after the toggle and everything else put it against the panel edge, so the
                    two started at different places and a tab holding both read as two lists that had
                    been stapled together.

                    A rule between fields rather than more space. The hints run to three lines, and at
                    that length the eye needs something that says where one setting ends rather than
                    a gap it has to judge against the gap inside a field.
                  -->
                  <div v-for="field in showing" :key="field.key" class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                    <!--
                      The control goes to the right of the row rather than in front of the label,
                      which is what puts every label on the same line as every other. A switch is the
                      width of a thumb, so it takes the end of the row and the words take the rest.
                    -->
                    <label
                      v-if="field.type === 'switch'"
                      class="flex cursor-pointer items-start justify-between gap-4"
                    >
                      <span class="flex min-w-0 flex-col gap-1">
                        <span class="text-sm">{{ t(settingLabel(field.key)) }}</span>
                        <span class="text-xs opacity-60">{{ t(settingHint(field.key)) }}</span>
                      </span>
                      <input
                        v-model="switches[field.key].value"
                        type="checkbox"
                        class="toggle toggle-primary toggle-sm mt-0.5 shrink-0"
                      />
                    </label>

                    <template v-else>
                      <!--
                        Stacked rather than in a row: a pattern is a line of code, and it needs the
                        width of the panel plus room underneath for what it reads out of a sample.
                      -->
                      <span class="flex flex-col gap-1">
                        <span class="text-sm">{{ t(settingLabel(field.key)) }}</span>
                        <span class="text-xs opacity-60">{{ t(settingHint(field.key)) }}</span>
                      </span>

                      <RegexField
                        v-if="field.type === 'regex'"
                        v-model="settings[field.key] as string"
                        :default="field.default"
                        :sample="field.sample"
                        :placeholder="field.default"
                      />

                      <PlayerListField
                        v-else-if="field.type === 'players'"
                        v-model="settings[field.key] as string"
                      />

                      <!--
                        A select over what the fleet is offering, plus the empty option, which is
                        not "off" but "as it is": an agent with no proxy connects from its host's
                        own address, which is what every agent did before this existed.
                      -->
                      <template v-else-if="field.type === 'proxy'">
                        <select
                          v-if="routes.length"
                          v-model="settings[field.key]"
                          class="select select-sm w-full max-w-xs"
                        >
                          <option value="">{{ t('configuration.settings.connect_proxy.direct') }}</option>
                          <option v-for="route in routes" :key="route.key" :value="route.name">
                            {{ route.label }} · {{ route.detail }}
                          </option>
                        </select>
                        <p v-else class="text-xs opacity-60">
                          {{ t('configuration.settings.connect_proxy.none') }}
                        </p>
                      </template>

                      <select
                        v-else-if="field.type === 'choice'"
                        v-model="settings[field.key]"
                        class="select select-sm w-full max-w-xs"
                      >
                        <option v-for="value in field.options" :key="value || 'auto'" :value="value">
                          {{ t(optionLabel(field.key, value)) }}
                        </option>
                      </select>

                      <!--
                        A position between two trades rather than a number anybody would type. Unset
                        reads as the middle, which is also what the host takes an unset one to mean,
                        so the thumb never says something different from what the agent does.
                      -->
                      <div v-else-if="field.type === 'range'" class="flex w-full max-w-xs flex-col gap-1">
                        <input
                          v-model="settings[field.key]"
                          type="range"
                          class="range range-primary range-xs"
                          :min="field.min"
                          :max="field.max"
                          :step="field.step"
                        />
                        <span class="flex justify-between text-xs opacity-60">
                          <span>{{ t(rangeEnd(field.key, 'low')) }}</span>
                          <span>{{ t(rangeEnd(field.key, 'high')) }}</span>
                        </span>
                      </div>

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
              Update sends the tab on screen and nothing else, so what it will and will not send has
              to be legible from here: this tab's state on the left, and any tab left behind named
              rather than counted.
            -->
            <div class="border-base-300 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-4">
              <span v-if="dirty" class="text-warning text-xs">{{ t('configuration.unsaved') }}</span>
              <span v-else-if="saved" class="text-success flex items-center gap-1 text-xs">
                <Check class="size-3.5" />
                {{ saved }}
              </span>

              <span v-if="unsentElsewhere.length" class="text-xs opacity-60">
                {{ t('configuration.unsentElsewhere', { tabs: unsentElsewhere.join(', ') }) }}
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
