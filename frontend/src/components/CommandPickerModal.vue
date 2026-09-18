<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'

import PlayerHead from './PlayerHead.vue'
import { COMMANDS, COMMAND_NAMES, elevated } from '../lib/configuration'

/**
 * Which commands one player may use, ticked one at a time.
 *
 * A dialog rather than a row that unfolds. Ten commands and their descriptions do not fit beside a
 * name in a list, and a whitelist is read *down* — a row that grows to three times its height while
 * being edited pushes every other player off the screen, which is the list somebody came here to
 * check.
 *
 * **Edited on a copy, applied on Done.** The list behind this is one string in one setting, so a
 * tick that wrote straight through would leave the form dirty from a dialog somebody then cancelled.
 */
const open = defineModel<boolean>('open', { required: true })

/**
 * Whose commands these are, and what they currently hold.
 *
 * Both are empty while nothing is being edited: this is mounted for the life of the list rather
 * than created when a row is clicked, because a dialog opens from a watch on {@link open} and a
 * watch only fires on a *change* - a component built with it already true never sees one.
 */
const props = defineProps<{
  name: string
  commands: string[]
}>()

const emit = defineEmits<{ apply: [commands: string[]] }>()

const { t } = useI18n()

const dialogEl = ref<InstanceType<typeof ModalShell> | null>(null)
const picked = ref<string[]>([])

watch(open, (isOpen) => {
  if (isOpen) {
    picked.value = [...props.commands]
    dialogEl.value?.showModal()
  } else {
    dialogEl.value?.close()
  }
})

/**
 * Commands held that this build cannot name.
 *
 * Written by a newer Osmium, shown so nobody wonders where they went, and carried through untouched
 * — dropping them here would revoke a grant every time an older interface saved the form.
 */
const unknown = computed(() => picked.value.filter((name) => !(name in COMMANDS)))

const all = computed(() => COMMAND_NAMES.every((name) => picked.value.includes(name)))

function toggleAll(): void {
  // The unknown ones are kept either way: they are not this control's to grant or revoke.
  picked.value = all.value ? [...unknown.value] : [...COMMAND_NAMES, ...unknown.value]
}

function done(): void {
  // Written in the table's order, so the setting reads the same however somebody arrived at it.
  emit('apply', [...COMMAND_NAMES.filter((name) => picked.value.includes(name)), ...unknown.value])
  open.value = false
}
</script>

<template>
  <ModalShell ref="dialogEl" :title="t('configuration.players.pickTitle')" :icon="Terminal" @close="open = false">
    <div class="mt-3 flex items-center gap-2.5">
      <PlayerHead :id="name" :name="name" size="sm" class="shrink-0" />
      <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ name }}</span>
      <span class="badge badge-sm">
        {{ t('configuration.players.count_commands', { count: picked.length }, picked.length) }}
      </span>
    </div>

    <p class="mt-3 text-xs opacity-60">{{ t('configuration.players.pickHint') }}</p>

    <div class="mt-3 flex items-center justify-between">
      <span class="text-xs font-medium opacity-60">{{ t('configuration.players.commands') }}</span>
      <button class="btn btn-ghost btn-xs" type="button" @click="toggleAll">
        {{ all ? t('configuration.players.pickNone') : t('configuration.players.pickAll') }}
      </button>
    </div>

    <ul class="-mx-2 mt-1 flex max-h-[22rem] flex-col gap-0.5 overflow-y-auto">
      <li v-for="command in COMMAND_NAMES" :key="command">
        <label
          class="rounded-field hover:bg-base-300/40 flex cursor-pointer items-center gap-3 px-2 py-1.5 transition-colors"
        >
          <input
            v-model="picked"
            type="checkbox"
            :value="command"
            class="checkbox checkbox-sm"
            :class="elevated(command) ? 'checkbox-warning' : ''"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-sm" :class="elevated(command) ? 'text-warning' : ''">
              {{ command }}
            </span>
            <span class="block truncate text-xs opacity-50">
              {{ t(`configuration.players.command.${command}`) }}
            </span>
          </span>
          <!--
            Named on the row that carries it rather than explained once at the top: an operator
            scanning for what is safe to grant should not have to hold a legend in their head.
          -->
          <span v-if="elevated(command)" class="badge badge-xs badge-warning shrink-0">
            {{ t('configuration.players.elevated') }}
          </span>
        </label>
      </li>
    </ul>

    <div v-if="unknown.length" class="mt-2 flex flex-wrap items-center gap-1.5">
      <span class="text-xs opacity-60">{{ t('configuration.players.unknownCommand') }}</span>
      <span v-for="command in unknown" :key="command" class="badge badge-xs badge-ghost font-mono">
        {{ command }}
      </span>
    </div>

    <div class="modal-action">
      <button class="btn btn-ghost btn-sm" type="button" @click="open = false">
        {{ t('common.cancel') }}
      </button>
      <button class="btn btn-primary btn-sm" type="button" @click="done">
        {{ t('common.done') }}
      </button>
    </div>
  </ModalShell>
</template>
