<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, KeyRound } from 'lucide-vue-next'
import AlertNote from './AlertNote.vue'

/**
 * A host's enrolment token, shown the once, with the copy button and everything said around it.
 *
 * Enrolling a host and rotating its token end the same way — this panel — and each dialog had
 * written its own, down to its own copy of the failure handling below.
 *
 * **The one click in the application whose silent failure is permanent.** `writeText` rejects on a
 * denied permission and in any non-secure context, and unhandled the button simply stays on "Copy":
 * an operator who clicked it, saw nothing change and closed the dialog has lost the credential. So
 * the failure is caught and said out loud, while the token is still on screen to copy by hand.
 */
const props = defineProps<{ token: string; hint?: string }>()

const { t } = useI18n()

const copied = ref(false)
const failed = ref(false)

// A second token is a second chance to copy it, and the first one's state says nothing about it.
watch(
  () => props.token,
  () => {
    copied.value = false
    failed.value = false
  },
)

async function copy() {
  if (!props.token) return
  try {
    await navigator.clipboard.writeText(props.token)
    copied.value = true
  } catch {
    failed.value = true
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <AlertNote kind="warning" :message="t('hosts.tokenWarning')" />

    <label class="input w-full">
      <KeyRound class="size-4 opacity-60" />
      <input class="font-mono text-sm" :value="token" readonly />
      <button type="button" class="btn btn-ghost btn-xs gap-1" @click="copy">
        <Copy class="size-3.5" />
        {{ copied ? t('common.copied') : t('common.copy') }}
      </button>
    </label>

    <!-- Says what to do instead. The token is still on screen, so this is recoverable — but only if
         the operator is told the click did not work. -->
    <AlertNote v-if="failed" kind="warning" :message="t('common.copyFailed')" />

    <p class="text-xs opacity-60">{{ hint ?? t('hosts.tokenHint') }}</p>
  </div>
</template>
