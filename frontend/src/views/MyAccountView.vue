<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CheckCheck,
  CircleAlert,
  CircleCheck,
  KeyRound,
  PencilLine,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from 'lucide-vue-next'
import { api, errorMessage, type RoleResponse } from '../api/client'
import FormField from '../components/FormField.vue'
import { nodeLabel } from '../lib/nodeLabel'
import { roleIcon } from '../lib/roleIcon'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

const username = ref(auth.user?.username ?? '')
const renameState = ref<{ error?: string; done?: boolean }>({})

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
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
  confirmPassword.value = ''
  passwordState.value = {}
  dialog('change-password')?.showModal()
}

async function rename() {
  renameState.value = {}
  const { error } = await api.PATCH('/api/users/me', { body: { username: username.value } })
  if (error) {
    renameState.value = { error: errorMessage(error, t('errors.renameAccount')) }
    return
  }
  // The token's subject no longer resolves, so the session is dead on the next request.
  renameState.value = { done: true }
}

async function changePassword() {
  passwordState.value = {}

  if (newPassword.value !== confirmPassword.value) {
    passwordState.value = { error: t('errors.passwordMismatch') }
    return
  }

  const { error } = await api.POST('/api/auth/password', {
    body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
  })
  if (error) {
    passwordState.value = { error: errorMessage(error, t('errors.changePassword')) }
    return
  }
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  passwordState.value = { done: true }
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('account.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('account.subtitle') }}</p>
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
              <span v-else class="badge badge-ghost badge-sm mt-2">{{ t('account.noRole') }}</span>
            </div>
          </div>

          <div class="border-base-300 flex flex-col gap-2 border-t pt-4">
            <button
              v-if="auth.can('user.edit.self')"
              class="btn btn-soft btn-sm w-full justify-start gap-3"
              @click="openRename"
            >
              <PencilLine class="size-4 opacity-70" />
              {{ t('account.rename') }}
            </button>
            <button class="btn btn-soft btn-sm w-full justify-start gap-3" @click="openPassword">
              <KeyRound class="size-4 opacity-70" />
              {{ t('account.changePassword') }}
            </button>
          </div>
        </div>
      </div>

      <div class="card border-base-300 bg-base-200 border lg:col-span-2">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <ShieldCheck class="text-primary size-4" />
            {{ t('account.role') }}
          </h2>
          <p class="text-sm opacity-60">
            {{ t('account.roleHint') }}
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
                  <span v-if="tier.current" class="badge badge-primary badge-xs">{{ t('account.current') }}</span>
                  <span v-else-if="tier.held" class="text-xs opacity-50">{{ t('account.included') }}</span>
                </div>
                <div v-if="tier.nodes.length" class="mt-1.5 flex flex-wrap gap-1">
                  <span
                    v-for="node in tier.nodes"
                    :key="node"
                    class="badge badge-ghost badge-sm"
                    :title="node"
                  >
                    {{ nodeLabel(node) }}
                  </span>
                </div>
                <div v-else class="mt-1 text-xs opacity-50">{{ t('account.permissionsHidden') }}</div>
              </div>
            </li>
          </ul>

          <div v-else class="flex items-center gap-2 py-6 text-sm opacity-60">
            <TriangleAlert class="size-4" />
            {{ t('account.noRoleAssigned') }}
          </div>
        </div>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-3">
        <h2 class="card-title flex items-center gap-2 text-base">
          <KeyRound class="text-primary size-4" />
          {{ t('account.permissions') }}
          <span class="badge badge-ghost badge-sm">{{ auth.user?.nodes?.length ?? 0 }}</span>
        </h2>
        <p class="text-sm opacity-60">
          {{ t('account.permissionsHint') }}
        </p>
        <div class="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="node in auth.user?.nodes ?? []"
            :key="node"
            class="rounded-field bg-base-300/30 flex items-center gap-2.5 px-3 py-2"
          >
            <KeyRound class="text-primary size-3.5 shrink-0 opacity-70" />
            <span class="min-w-0">
              <span class="block truncate text-sm">{{ nodeLabel(node) }}</span>
              <span class="block truncate font-mono text-[0.7rem] opacity-40">{{ node }}</span>
            </span>
          </div>
          <span v-if="!auth.user?.nodes?.length" class="text-sm opacity-60">{{ t('account.noPermissions') }}</span>
        </div>
      </div>
    </div>

    <dialog id="rename-account" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <PencilLine class="text-primary size-5" />
          {{ t('account.rename') }}
        </h3>
        <p class="mt-1 text-sm opacity-60">
          {{ t('account.renameWarning') }}
        </p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="rename">
          <FormField
            v-model="username"
            :label="t('account.username')"
            :icon="UserRound"
            type="text"
            maxlength="64"
            required
          />

          <div v-if="renameState.error" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ renameState.error }}</span>
          </div>
          <div v-else-if="renameState.done" role="alert" class="alert alert-warning alert-soft">
            <TriangleAlert class="size-4" />
            <span>{{ t('account.renamed') }}</span>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('rename-account')?.close()">
              {{ t('common.close') }}
            </button>
            <button class="btn btn-primary btn-sm" type="submit">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog id="change-password" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="text-primary size-5" />
          {{ t('account.changePassword') }}
        </h3>
        <p class="mt-1 text-sm opacity-60">{{ t('account.passwordHint') }}</p>
        <form class="mt-5 flex flex-col gap-4" @submit.prevent="changePassword">
          <FormField
            v-model="currentPassword"
            :label="t('account.currentPassword')"
            :icon="KeyRound"
            type="password"
            autocomplete="current-password"
            required
          />
          <FormField
            v-model="newPassword"
            :label="t('account.newPassword')"
            :icon="KeyRound"
            type="password"
            autocomplete="new-password"
            minlength="4"
            maxlength="72"
            required
          />
          <FormField
            v-model="confirmPassword"
            :label="t('account.confirmPassword')"
            :placeholder="t('account.confirmPlaceholder')"
            :icon="CheckCheck"
            :invalid="Boolean(confirmPassword) && confirmPassword !== newPassword"
            type="password"
            autocomplete="new-password"
            required
          />

          <div v-if="passwordState.error" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ passwordState.error }}</span>
          </div>
          <div v-else-if="passwordState.done" role="alert" class="alert alert-success alert-soft">
            <CircleCheck class="size-4" />
            <span>{{ t('account.passwordChanged') }}</span>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('change-password')?.close()">
              {{ t('common.close') }}
            </button>
            <button class="btn btn-primary btn-sm" type="submit">{{ t('account.changePassword') }}</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>
</template>
