<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Box, TriangleAlert, Upload } from 'lucide-vue-next'
import FormField from './FormField.vue'
import { uploadSchematic, type SchematicResponse } from '../api/schematics'

/**
 * Sending a schematic, out of the way until it is wanted.
 *
 * A form that is only used once per schematic does not need to sit beside the library it fills —
 * and an upload that runs for an hour is better in a dialog that can be dismissed than in a panel
 * that is always half of the screen.
 *
 * The transfer survives the dialog closing. It is a promise held by this component, not by the
 * markup, so the operator can shut it and watch the row's own progress bar in the list instead.
 */
const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{ created: [SchematicResponse] }>()

const { t } = useI18n()

const dialogEl = ref<HTMLDialogElement | null>(null)
const name = ref('')
const file = ref<File | null>(null)
const error = ref<string | null>(null)
const sending = ref(false)
const percent = ref(0)
const upload = ref<AbortController | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    // Not reset while a transfer is running: reopening mid-upload should show where it got to.
    if (!sending.value) {
      name.value = ''
      file.value = null
      percent.value = 0
    }
    error.value = null
    dialogEl.value?.showModal()
  } else {
    dialogEl.value?.close()
  }
})

function pick(event: Event) {
  const chosen = (event.target as HTMLInputElement).files?.[0] ?? null
  file.value = chosen
  // The file's name is the obvious first guess and almost always right; the operator can edit it.
  if (chosen && !name.value.trim()) name.value = chosen.name.replace(/\.[^.]+$/, '')
}

async function send() {
  if (!file.value || !name.value.trim()) return

  sending.value = true
  percent.value = 0
  error.value = null
  upload.value = new AbortController()

  try {
    const created = await uploadSchematic({
      name: name.value.trim(),
      file: file.value,
      signal: upload.value.signal,
      onProgress: ({ sent, total }) => {
        percent.value = Math.round((sent / total) * 100)
      },
    })
    emit('created', created)
    open.value = false
  } catch (failure) {
    // Cancelling is a choice, not a failure. What is left behind is a partial upload the operator
    // can continue, which is the point of sending it in chunks at all.
    if (!upload.value?.signal.aborted) {
      error.value = failure instanceof Error ? failure.message : t('errors.generic')
    }
  } finally {
    sending.value = false
    upload.value = null
  }
}
</script>

<template>
  <dialog ref="dialogEl" class="modal" @close="open = false">
    <div class="modal-box">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <Box class="text-primary size-5" />
        {{ t('schematics.uploadTitle') }}
      </h3>

      <form class="mt-5 flex flex-col gap-4" @submit.prevent="send">
        <p class="text-sm opacity-60">{{ t('schematics.uploadIntro') }}</p>

        <FormField
          v-model="name"
          :label="t('schematics.name')"
          :placeholder="t('schematics.namePlaceholder')"
          :icon="Box"
          type="text"
          maxlength="128"
          :disabled="sending"
          required
        />

        <!-- Native: a file picker is the browser's own control, and a floating label over it would
             cover the button that makes it work. -->
        <input
          type="file"
          accept=".litematic,.schem,.schematic"
          class="file-input w-full"
          :disabled="sending"
          @change="pick"
        />

        <div v-if="sending" class="flex flex-col gap-1">
          <progress class="progress progress-primary w-full" :value="percent" max="100"></progress>
          <p class="text-xs opacity-60">{{ t('schematics.uploading', { percent }) }}</p>
        </div>

        <div v-if="error" role="alert" class="alert alert-error alert-soft">
          <TriangleAlert class="size-4" />
          <span>{{ error }}</span>
        </div>

        <div class="modal-action">
          <!-- Closing leaves the transfer running; cancelling stops it and keeps what arrived. -->
          <button
            v-if="sending"
            class="btn btn-ghost btn-sm"
            type="button"
            @click="upload?.abort()"
          >
            {{ t('schematics.cancel') }}
          </button>
          <button v-else class="btn btn-ghost btn-sm" type="button" @click="open = false">
            {{ t('common.cancel') }}
          </button>

          <button
            class="btn btn-primary btn-sm gap-2"
            type="submit"
            :disabled="sending || !file || !name.trim()"
          >
            <Upload class="size-4" />
            {{ t('schematics.upload') }}
          </button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>{{ t('common.close') }}</button>
    </form>
  </dialog>
</template>
