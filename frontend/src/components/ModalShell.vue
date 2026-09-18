<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The dialog every modal in the application is: a `<dialog>`, a box, a heading, and the backdrop
 * that dismisses it.
 *
 * **Twenty-four of these were written out by hand**, and the copies had drifted — a heading with an
 * icon here and without one there, a backdrop whose button said different things, and the `cancel`
 * handling below reasoned out twice in two comments.
 *
 * Opened imperatively, like the element it wraps: a call site keeps its `showModal()` and `close()`
 * and its own state, so this changes the markup and nothing about how a dialog behaves.
 *
 * `dismissible` is the one real behaviour here. A dialog showing something that cannot be retrieved
 * — a host's token, shown once — must not be dismissed by a stray Escape or a click beside it, and
 * `cancel` is the event Escape fires. Both are refused together, because a backdrop that closes what
 * Escape may not is the same accident with a different gesture.
 */
const props = withDefaults(
  defineProps<{
    title?: string
    icon?: unknown
    /**
     * What the heading's icon means. Muted by default, because an icon that only labels a dialog is
     * decoration; `error` for a destructive act and `warning` for one that costs somebody else
     * something — signing every session out from under them.
     */
    tone?: 'muted' | 'error' | 'warning'
    dismissible?: boolean
    /** For the few boxes that are not the default width. */
    boxClass?: string
  }>(),
  { dismissible: true, tone: 'muted' },
)

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

const TONE = { muted: 'text-base-content/50', error: 'text-error', warning: 'text-warning' } as const

const dialog = ref<HTMLDialogElement | null>(null)

defineExpose({
  showModal: () => dialog.value?.showModal(),
  close: () => dialog.value?.close(),
})
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    @close="emit('close')"
    @cancel="!props.dismissible && $event.preventDefault()"
  >
    <div class="modal-box" :class="boxClass">
      <h3 v-if="title" class="flex items-center gap-2 text-lg font-semibold">
        <component :is="icon" v-if="icon" class="size-5" :class="TONE[tone]" />
        {{ title }}
      </h3>
      <slot />
    </div>

    <form v-if="dismissible" method="dialog" class="modal-backdrop">
      <button>{{ t('common.close') }}</button>
    </form>
  </dialog>
</template>
