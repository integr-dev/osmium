<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CircleAlert, KeyRound, LogIn, UserRound } from 'lucide-vue-next'
import FormField from '../components/FormField.vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = null
  try {
    await auth.login(username.value, password.value)
    const redirect = route.query.redirect
    await router.push(typeof redirect === 'string' ? redirect : { name: 'account' })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Login failed'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
    <!-- Soft brand glow behind the card; purely decorative. -->
    <div
      class="bg-primary/10 pointer-events-none absolute -top-40 left-1/2 size-[28rem] -translate-x-1/2 rounded-full blur-3xl"
      aria-hidden="true"
    ></div>

    <div class="relative w-full max-w-sm">
      <div class="card border-base-300 bg-base-100 border">
        <div class="card-body gap-6 p-8">
          <div class="flex flex-col items-center gap-3">
            <img src="/logo.svg" alt="" class="size-14" />
            <div class="text-center">
              <h1 class="text-2xl font-semibold tracking-tight">Osmium</h1>
              <p class="text-sm opacity-60">Sign in to continue</p>
            </div>
          </div>

          <form class="flex flex-col gap-4" @submit.prevent="submit">
            <FormField
              v-model="username"
              label="Username"
              :icon="UserRound"
              type="text"
              autocomplete="username"
              required
            />

            <FormField
              v-model="password"
              label="Password"
              :icon="KeyRound"
              type="password"
              autocomplete="current-password"
              required
            />

            <div v-if="error" role="alert" class="alert alert-error alert-soft">
              <CircleAlert class="size-4" />
              <span>{{ error }}</span>
            </div>

            <button class="btn btn-primary btn-block gap-2" type="submit" :disabled="busy">
              <span v-if="busy" class="loading loading-spinner loading-sm"></span>
              <LogIn v-else class="size-4" />
              Log in
            </button>
          </form>
        </div>
      </div>

      <p class="mt-6 text-center text-xs opacity-40">
        Accounts are created by an administrator.
      </p>
    </div>
  </div>
</template>
