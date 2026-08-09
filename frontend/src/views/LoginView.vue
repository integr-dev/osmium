<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CircleAlert, KeyRound, LogIn, UserRound } from 'lucide-vue-next'
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
  <div class="flex min-h-screen items-center justify-center p-6">
    <div class="w-full max-w-sm">
      <div class="mb-8 flex flex-col items-center gap-3">
        <img src="/logo.svg" alt="" class="size-14" />
        <div class="text-center">
          <h1 class="text-2xl font-semibold tracking-tight">Osmium</h1>
          <p class="text-sm opacity-60">Sign in to continue</p>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <form class="card-body gap-4" @submit.prevent="submit">
          <label class="input w-full">
            <UserRound class="size-4 opacity-60" />
            <input
              v-model="username"
              type="text"
              placeholder="Username"
              autocomplete="username"
              required
            />
          </label>

          <label class="input w-full">
            <KeyRound class="size-4 opacity-60" />
            <input
              v-model="password"
              type="password"
              placeholder="Password"
              autocomplete="current-password"
              required
            />
          </label>

          <div v-if="error" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ error }}</span>
          </div>

          <button class="btn btn-primary gap-2" type="submit" :disabled="busy">
            <span v-if="busy" class="loading loading-spinner loading-sm"></span>
            <LogIn v-else class="size-4" />
            Log in
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
