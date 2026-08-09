<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  PencilLine,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-vue-next'
import { api, errorMessage, type RoleResponse } from '../api/client'
import { roleIcon } from '../lib/roleIcon'
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

/**
 * The seniority ladder, derived rather than hardcoded: roles are strictly nested, so ordering by
 * node count reproduces viewer < orchestrator < administrator without duplicating backend knowledge.
 * Without role.read there is nothing to order, so fall back to the single held role.
 */
const tiers = computed(() => {
  const current = auth.user?.role ?? null
  const known = [...roleDetails.value].sort((a, b) => a.nodes.length - b.nodes.length)

  if (known.length === 0) {
    return current ? [{ name: current, held: true, current: true, nodes: [] as string[] }] : []
  }

  const currentIndex = known.findIndex((role) => role.name === current)
  return known.map((role, index) => ({
    name: role.name,
    held: currentIndex >= 0 && index <= currentIndex,
    current: role.name === current,
    nodes: role.nodes,
  }))
})

onMounted(async () => {
  if (!auth.can('role.read')) return
  const { data } = await api.GET('/api/roles')
  roleDetails.value = (data ?? []) as RoleResponse[]
})

function dialog(id: string): HTMLDialogElement | null {
  return document.getElementById(id) as HTMLDialogElement | null
}

function openRename() {
  username.value = auth.user?.username ?? ''
  renameState.value = {}
  dialog('rename-account')?.showModal()
}

function openPassword() {
  currentPassword.value = ''
  newPassword.value = ''
  passwordState.value = {}
  dialog('change-password')?.showModal()
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
      <p class="text-sm opacity-60">Your identity, role and effective permissions.</p>
    </header>

    <div class="grid gap-6 lg:grid-cols-3">
      <div class="card border-base-300 bg-base-200 border lg:col-span-1">
        <div class="card-body gap-0">
          <div class="flex flex-col items-center gap-3 pb-6 text-center">
            <div class="avatar avatar-placeholder">
              <div
                class="bg-primary text-primary-content ring-primary/20 w-20 rounded-full ring-4 ring-offset-0"
              >
                <span class="text-2xl font-semibold">{{ initial }}</span>
              </div>
            </div>
            <div>
              <div class="text-lg leading-tight font-semibold">{{ auth.user?.username }}</div>
              <span
                v-if="auth.user?.role"
                class="badge badge-primary badge-soft badge-sm mt-2 gap-1 capitalize"
              >
                <component :is="roleIcon(auth.user.role)" class="size-3" />
                {{ auth.user.role }}
              </span>
              <span v-else class="badge badge-ghost badge-sm mt-2">No role</span>
            </div>
          </div>

          <div class="stats stats-horizontal border-base-300 bg-base-300/25 w-full border">
            <div class="stat place-items-center gap-1 px-2 py-4">
              <div class="stat-title text-xs">Nodes</div>
              <div class="stat-value text-2xl">{{ auth.user?.nodes?.length ?? 0 }}</div>
            </div>
            <div class="stat place-items-center gap-1 px-2 py-4">
              <div class="stat-title text-xs">Tiers held</div>
              <div class="stat-value text-2xl">{{ tiers.filter((tier) => tier.held).length }}</div>
            </div>
          </div>

          <div class="flex flex-col gap-2 pt-4">
            <button
              v-if="auth.can('user.edit.self')"
              class="btn btn-outline btn-sm w-full justify-start gap-3"
              @click="openRename"
            >
              <PencilLine class="size-4" />
              Rename account
            </button>
            <button class="btn btn-outline btn-sm w-full justify-start gap-3" @click="openPassword">
              <KeyRound class="size-4" />
              Change password
            </button>
          </div>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border lg:col-span-2">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <ShieldCheck class="text-primary size-4" />
            Role
          </h2>
          <p class="text-sm opacity-60">
            Roles are nested levels, so an account holds exactly one. Each tier includes everything
            the tier below it grants.
          </p>

          <ul v-if="auth.user?.role" class="flex flex-col gap-2">
            <li
              v-for="tier in tiers"
              :key="tier.name"
              class="rounded-box flex items-start gap-3 border p-3 transition-colors"
              :class="
                tier.current
                  ? 'border-primary/50 bg-primary/5'
                  : tier.held
                    ? 'border-base-300 bg-base-300/20'
                    : 'border-base-300/50 opacity-40'
              "
            >
              <div
                class="rounded-field flex size-9 shrink-0 items-center justify-center"
                :class="tier.held ? 'bg-primary/15 text-primary' : 'bg-base-300/40'"
              >
                <component :is="roleIcon(tier.name)" class="size-4.5" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium capitalize">{{ tier.name }}</span>
                  <span v-if="tier.current" class="badge badge-primary badge-xs">current</span>
                  <span v-else-if="tier.held" class="text-xs opacity-50">included</span>
                </div>
                <div v-if="tier.nodes.length" class="mt-1.5 flex flex-wrap gap-1">
                  <span
                    v-for="node in tier.nodes"
                    :key="node"
                    class="badge badge-ghost badge-xs font-mono"
                  >
                    {{ node }}
                  </span>
                </div>
                <div v-else class="mt-1 text-xs opacity-50">Node breakdown needs role.read</div>
              </div>
            </li>
          </ul>

          <div v-else class="flex items-center gap-2 py-6 text-sm opacity-60">
            <TriangleAlert class="size-4" />
            No role assigned. An administrator has to grant one.
          </div>
        </div>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <KeyRound class="text-primary size-4" />
          Effective permissions
          <span class="badge badge-ghost badge-sm">{{ auth.user?.nodes?.length ?? 0 }}</span>
        </h2>
        <p class="text-sm opacity-60">
          The exact strings the API authorizes against. Everything your role and the tiers below it
          grant, flattened.
        </p>
        <div class="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="node in auth.user?.nodes ?? []"
            :key="node"
            class="rounded-field bg-base-300/30 flex items-center gap-2 px-2.5 py-1.5"
          >
            <KeyRound class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="truncate font-mono text-xs">{{ node }}</span>
          </div>
          <span v-if="!auth.user?.nodes?.length" class="text-sm opacity-60">None.</span>
        </div>
      </div>
    </div>

    <dialog id="rename-account" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <PencilLine class="text-primary size-5" />
          Rename account
        </h3>
        <p class="mt-1 text-sm opacity-60">
          Renaming ends the current session, because the token identifies you by username.
        </p>
        <form class="mt-4 flex flex-col gap-3" @submit.prevent="rename">
          <input v-model="username" class="input w-full" type="text" maxlength="64" required />

          <div v-if="renameState.error" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ renameState.error }}</span>
          </div>
          <div v-else-if="renameState.done" role="alert" class="alert alert-warning alert-soft">
            <TriangleAlert class="size-4" />
            <span>Renamed. Log in again to continue.</span>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('rename-account')?.close()">
              Close
            </button>
            <button class="btn btn-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>

    <dialog id="change-password" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          Change password
        </h3>
        <p class="mt-1 text-sm opacity-60">Requires your current password. 4–72 characters.</p>
        <form class="mt-4 flex flex-col gap-3" @submit.prevent="changePassword">
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

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('change-password')?.close()">
              Close
            </button>
            <button class="btn btn-primary btn-sm" type="submit">Change password</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>
  </div>
</template>
