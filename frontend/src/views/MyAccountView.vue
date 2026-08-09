<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  AtSign,
  CircleAlert,
  CircleCheck,
  KeyRound,
  PencilLine,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-vue-next'
import { api, errorMessage, type RoleResponse } from '../api/client'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()

const username = ref(auth.user?.username ?? '')
const renameState = ref<{ error?: string; done?: boolean }>({})

const currentPassword = ref('')
const newPassword = ref('')
const passwordState = ref<{ error?: string; done?: boolean }>({})

/** Only readable with role.read, so the node breakdown is a bonus, not a requirement. */
const roleDetails = ref<RoleResponse[]>([])

const initial = computed(() => (auth.user?.username ?? '?').charAt(0).toUpperCase())

onMounted(async () => {
  if (!auth.can('role.read')) return
  const { data } = await api.GET('/api/roles')
  roleDetails.value = (data ?? []) as RoleResponse[]
})

function nodesOf(role: string): string[] {
  return roleDetails.value.find((candidate) => candidate.name === role)?.nodes ?? []
}

async function rename() {
  renameState.value = {}
  const { error } = await api.PATCH('/api/users/me', { body: { username: username.value } })
  if (error) {
    renameState.value = { error: errorMessage(error, 'Could not rename the account') }
    return
  }
  // The token's subject no longer resolves, so the session is dead on the next request.
  renameState.value = { done: true }
}

async function changePassword() {
  passwordState.value = {}
  const { error } = await api.POST('/api/auth/password', {
    body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
  })
  if (error) {
    passwordState.value = { error: errorMessage(error, 'Could not change the password') }
    return
  }
  currentPassword.value = ''
  newPassword.value = ''
  passwordState.value = { done: true }
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">My account</h1>
      <p class="text-sm opacity-60">Your identity, roles and effective permissions.</p>
    </header>

    <div class="grid gap-6 lg:grid-cols-3">
      <div class="card border-base-300 bg-base-200 border lg:col-span-1">
        <div class="card-body items-center gap-4 text-center">
          <div class="avatar avatar-placeholder">
            <div class="bg-primary text-primary-content w-20 rounded-full">
              <span class="text-2xl font-semibold">{{ initial }}</span>
            </div>
          </div>
          <div>
            <div class="text-lg font-semibold">{{ auth.user?.username }}</div>
            <div class="flex items-center justify-center gap-1 text-sm opacity-60">
              <AtSign class="size-3.5" />
              <span>{{ auth.user?.roles?.join(', ') || 'no roles' }}</span>
            </div>
          </div>
          <div class="stats stats-horizontal bg-base-300/40 w-full">
            <div class="stat place-items-center py-3">
              <div class="stat-title text-xs">Roles</div>
              <div class="stat-value text-2xl">{{ auth.user?.roles?.length ?? 0 }}</div>
            </div>
            <div class="stat place-items-center py-3">
              <div class="stat-title text-xs">Nodes</div>
              <div class="stat-value text-2xl">{{ auth.user?.nodes?.length ?? 0 }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border lg:col-span-2">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <ShieldCheck class="text-primary size-4" />
            Roles
          </h2>

          <ul v-if="auth.user?.roles?.length" class="list">
            <li v-for="role in auth.user.roles" :key="role" class="list-row px-0">
              <div class="text-primary"><ShieldCheck class="size-5" /></div>
              <div>
                <div class="font-medium capitalize">{{ role }}</div>
                <div v-if="nodesOf(role).length" class="mt-1 flex flex-wrap gap-1">
                  <span v-for="node in nodesOf(role)" :key="node" class="badge badge-ghost badge-xs">
                    {{ node }}
                  </span>
                </div>
                <div v-else class="text-xs opacity-50">Node breakdown needs role.read</div>
              </div>
            </li>
          </ul>

          <div v-else class="flex items-center gap-2 py-6 text-sm opacity-60">
            <TriangleAlert class="size-4" />
            No roles assigned. An administrator has to grant one.
          </div>
        </div>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <KeyRound class="text-primary size-4" />
          Effective permissions
        </h2>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="node in auth.user?.nodes ?? []" :key="node" class="badge badge-soft badge-sm">
            {{ node }}
          </span>
          <span v-if="!auth.user?.nodes?.length" class="text-sm opacity-60">None.</span>
        </div>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <div v-if="auth.can('user.edit.self')" class="card border-base-300 bg-base-200 border">
        <form class="card-body gap-3" @submit.prevent="rename">
          <h2 class="card-title flex items-center gap-2 text-base">
            <PencilLine class="text-primary size-4" />
            Username
          </h2>
          <p class="text-sm opacity-60">
            Renaming ends the current session, because the token identifies you by username.
          </p>
          <input v-model="username" class="input w-full" type="text" maxlength="64" required />

          <div v-if="renameState.error" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ renameState.error }}</span>
          </div>
          <div v-else-if="renameState.done" role="alert" class="alert alert-warning alert-soft">
            <TriangleAlert class="size-4" />
            <span>Renamed. Log in again to continue.</span>
          </div>

          <div class="card-actions justify-end">
            <button class="btn btn-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <form class="card-body gap-3" @submit.prevent="changePassword">
          <h2 class="card-title flex items-center gap-2 text-base">
            <KeyRound class="text-primary size-4" />
            Password
          </h2>
          <p class="text-sm opacity-60">Requires your current password. 4–72 characters.</p>
          <input
            v-model="currentPassword"
            class="input w-full"
            type="password"
            placeholder="Current password"
            autocomplete="current-password"
            required
          />
          <input
            v-model="newPassword"
            class="input w-full"
            type="password"
            placeholder="New password"
            autocomplete="new-password"
            minlength="4"
            maxlength="72"
            required
          />

          <div v-if="passwordState.error" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ passwordState.error }}</span>
          </div>
          <div v-else-if="passwordState.done" role="alert" class="alert alert-success alert-soft">
            <CircleCheck class="size-4" />
            <span>Password changed.</span>
          </div>

          <div class="card-actions justify-end">
            <button class="btn btn-primary btn-sm" type="submit">Change password</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
