<script setup lang="ts">
import { ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, Server, UserPlus } from 'lucide-vue-next'
import FormField from './FormField.vue'
import { useBotStore } from '../stores/bots'
import { useRouter } from 'vue-router'

const open = defineModel<boolean>('open', { required: true })

const botStore = useBotStore()
const router = useRouter()

const dialogEl = ref<HTMLDialogElement | null>(null)
const step = ref<1 | 2>(1)
const draft = ref({ label: '', serverAddress: '', hostId: null as number | null })
const error = ref<string | null>(null)
const busy = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    draft.value = { label: '', serverAddress: '', hostId: botStore.hosts[0]?.id ?? null }
    step.value = 1
    error.value = null
    dialogEl.value?.showModal()
  } else {
    dialogEl.value?.close()
  }
})

async function submit() {
  if (step.value === 1) {
    step.value = 2
    return
  }
  if (draft.value.hostId === null) {
    error.value = 'Pick a host to run this bot'
    return
  }

  busy.value = true
  error.value = null
  try {
    const bot = await botStore.addBot({
      label: draft.value.label,
      serverAddress: draft.value.serverAddress,
      hostId: draft.value.hostId,
    })
    open.value = false
    void router.push({ name: 'bot', params: { id: bot.id } })
  } catch (failure) {
    // Conflicts and validation errors are all step 1 fields, so send the operator back.
    step.value = 1
    error.value = failure instanceof Error ? failure.message : 'Could not create the bot'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dialogEl" class="modal" @close="open = false">
    <div class="modal-box">
      <h3 class="flex items-center gap-2 text-lg font-semibold">
        <UserPlus class="text-primary size-5" />
        New bot
      </h3>

      <ul class="steps mt-4 w-full">
        <li class="step step-primary text-xs">Identity</li>
        <li class="step text-xs" :class="step === 2 ? 'step-primary' : ''">Host</li>
      </ul>

      <form class="mt-5 flex flex-col gap-4" @submit.prevent="submit">
        <template v-if="step === 1">
          <FormField
            v-model="draft.label"
            label="Bot name"
            placeholder="e.g. Mason_04"
            :icon="UserPlus"
            type="text"
            maxlength="64"
            required
          />
          <FormField
            v-model="draft.serverAddress"
            label="Target server"
            placeholder="mc.example.com:25565"
            :icon="Server"
            type="text"
            required
          />
        </template>

        <template v-else>
          <p class="text-sm opacity-60">Which host runs this bot? Offline hosts can be assigned now and connected later.</p>
          <ul v-if="botStore.hosts.length" class="flex flex-col gap-1">
            <li v-for="host in botStore.hosts" :key="host.id">
              <label class="rounded-field hover:bg-base-300/50 flex cursor-pointer items-center gap-3 p-3">
                <input
                  v-model="draft.hostId"
                  type="radio"
                  name="bot-host"
                  class="radio radio-sm radio-primary shrink-0"
                  :value="host.id"
                />
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="host.reachable ? 'bg-success' : 'bg-error'"
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="block font-medium">{{ host.name }}</span>
                  <span class="block font-mono text-xs opacity-50">
                    {{ host.address ?? 'not yet connected' }}
                  </span>
                </span>
                <span class="text-xs opacity-50">{{ host.botCount }} bots</span>
              </label>
            </li>
          </ul>
          <p v-else class="rounded-field bg-base-300/30 px-3 py-4 text-center text-sm opacity-60">
            No hosts yet. Add one under Hosts first.
          </p>
        </template>

        <div v-if="error" role="alert" class="alert alert-error alert-soft">
          <span>{{ error }}</span>
        </div>

        <div class="modal-action">
          <button v-if="step === 2" class="btn btn-ghost btn-sm gap-1" type="button" @click="step = 1">
            <ChevronLeft class="size-4" />
            Back
          </button>
          <button v-else class="btn btn-ghost btn-sm" type="button" @click="open = false">Cancel</button>
          <button class="btn btn-primary btn-sm gap-1" type="submit" :disabled="busy || (step === 2 && !botStore.hosts.length)">
            {{ step === 1 ? 'Next' : 'Create' }}
            <ChevronRight v-if="step === 1" class="size-4" />
          </button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>
</template>
