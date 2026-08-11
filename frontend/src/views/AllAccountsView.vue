<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleSlash2,
  KeyRound,
  Plus,
  Search,
  SquarePen,
  Trash2,
  UserPlus,
  UserRound,
  UserRoundCog,
  Users,
} from 'lucide-vue-next'
import { api, errorMessage, type RoleResponse, type UserResponse } from '../api/client'
import FormField from '../components/FormField.vue'
import { nodeLabel } from '../lib/nodeLabel'
import { roleIcon } from '../lib/roleIcon'
import { useAuthStore } from '../stores/auth'
import { useAgentStore } from '../stores/agents'

const { t } = useI18n()
const auth = useAuthStore()
const agentStore = useAgentStore()

const users = ref<UserResponse[]>([])
const roles = ref<RoleResponse[]>([])
const error = ref<string | null>(null)
const loading = ref(true)
const query = ref('')

const draft = ref({
  username: '',
  password: '',
  confirmPassword: '',
  role: null as string | null,
})
const editing = ref<{ user: UserResponse; role: string | null } | null>(null)
const createStep = ref<1 | 2>(1)
const createError = ref<string | null>(null)
const editingUser = ref<{
  user: UserResponse
  username: string
  password: string
  confirmPassword: string
} | null>(null)

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return users.value
  return users.value.filter((user) => user.username.toLowerCase().includes(needle))
})

/**
 * Per-role headcount. Ordered by the seniority ladder when role.read is available, otherwise by
 * whatever roles actually appear on the accounts.
 */
const breakdown = computed(() => {
  const counts = new Map<string, number>()
  for (const user of users.value) {
    const key = user.role ?? ''
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const names = roles.value.length
    ? [...roles.value].sort((a, b) => a.nodes.length - b.nodes.length).map((role) => role.name)
    : [...counts.keys()].filter(Boolean).sort()

  return {
    roles: names.map((name) => ({ name, count: counts.get(name) ?? 0 })),
    none: counts.get('') ?? 0,
  }
})

let stopListening: (() => void) | null = null

onMounted(async () => {
  await Promise.all([loadUsers(), loadRoles()])
  loading.value = false

  // Two administrators can be on this page at once. Without this, one of them acts on a row the
  // other already deleted, and the failure looks like a bug rather than like stale information.
  stopListening = agentStore.onFeedEvent((name, data) => {
    if (name === 'user') upsertUser(data as UserResponse)
    if (name === 'user-removed') {
      const { id } = data as { id: number }
      users.value = users.value.filter((user) => user.id !== id)
    }
  })
})

onBeforeUnmount(() => stopListening?.())

/** Replaced in place, so the row keeps its position rather than jumping on every edit. */
function upsertUser(user: UserResponse) {
  const index = users.value.findIndex((held) => held.id === user.id)
  if (index === -1) users.value = [...users.value, user].sort((a, b) => a.username.localeCompare(b.username))
  else users.value[index] = user
}

function dialog(id: string): HTMLDialogElement | null {
  return document.getElementById(id) as HTMLDialogElement | null
}

async function loadUsers() {
  const { data, error: failure } = await api.GET('/api/users')
  if (failure) {
    error.value = errorMessage(failure, t('errors.loadAccounts'))
    return
  }
  users.value = (data ?? []) as UserResponse[]
}

async function loadRoles() {
  if (!auth.can('role.read')) return
  const { data } = await api.GET('/api/roles')
  roles.value = (data ?? []) as RoleResponse[]
}

function openCreate() {
  draft.value = { username: '', password: '', confirmPassword: '', role: null }
  createStep.value = 1
  createError.value = null
  dialog('create-user')?.showModal()
}

/** Step 1 collects credentials, step 2 the role, so one form handles both submits. */
function submitCreate() {
  if (createStep.value === 1) {
    if (draft.value.password !== draft.value.confirmPassword) {
      createError.value = t('errors.passwordMismatch')
      return
    }
    createError.value = null
    createStep.value = 2
    return
  }
  void createUser()
}

async function createUser() {
  createError.value = null

  const { error: failure } = await api.POST('/api/users', {
    body: {
      username: draft.value.username,
      password: draft.value.password,
      role: draft.value.role,
    },
  })
  if (failure) {
    // Conflicts and validation errors come from the step 1 fields, so send the user back.
    createStep.value = 1
    createError.value = errorMessage(failure, t('errors.createAccount'))
    return
  }
  dialog('create-user')?.close()
  await loadUsers()
}

async function saveRole() {
  if (!editing.value) return
  error.value = null
  const { error: failure } = await api.PUT('/api/users/{id}/role', {
    params: { path: { id: editing.value.user.id } },
    body: { role: editing.value.role },
  })
  if (failure) {
    error.value = errorMessage(failure, t('errors.changeRole'))
    return
  }
  editing.value = null
  dialog('edit-role')?.close()
  await loadUsers()
}

async function saveUser() {
  if (!editingUser.value) return
  error.value = null

  // Not trimmed: leading and trailing spaces are legitimate password characters.
  const password = editingUser.value.password
  if (password && password !== editingUser.value.confirmPassword) {
    error.value = t('errors.passwordMismatch')
    return
  }

  const { error: failure } = await api.PATCH('/api/users/{id}', {
    params: { path: { id: editingUser.value.user.id } },
    // Omitting the password leaves the existing one untouched.
    body: { username: editingUser.value.username, password: password || undefined },
  })
  if (failure) {
    error.value = errorMessage(failure, t('errors.updateAccount'))
    return
  }
  editingUser.value = null
  dialog('edit-user')?.close()
  await loadUsers()
}

async function remove(user: UserResponse) {
  error.value = null
  const { error: failure } = await api.DELETE('/api/users/{id}', {
    params: { path: { id: user.id } },
  })
  if (failure) {
    error.value = errorMessage(failure, t('errors.removeAccount'))
    return
  }
  await loadUsers()
}

function openRole(user: UserResponse) {
  editing.value = { user, role: user.role }
  dialog('edit-role')?.showModal()
}

function openEdit(user: UserResponse) {
  editingUser.value = { user, username: user.username, password: '', confirmPassword: '' }
  dialog('edit-user')?.showModal()
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('accounts.title') }}</h1>
        <p class="text-sm opacity-60">{{ t('accounts.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <label class="input input-sm w-56">
          <Search class="size-4 opacity-60" />
          <input v-model="query" type="search" :placeholder="t('accounts.filterPlaceholder')" />
        </label>
        <button v-if="auth.can('user.create')" class="btn btn-primary btn-sm gap-2" @click="openCreate">
          <Plus class="size-4" />
          {{ t('accounts.newAccount') }}
        </button>
      </div>
    </header>

    <div class="stats border-base-300 bg-base-200 w-full border">
      <div class="stat">
        <div class="stat-figure opacity-60"><Users class="size-7" /></div>
        <div class="stat-title">{{ t('accounts.count') }}</div>
        <div class="stat-value text-3xl">{{ users.length }}</div>
      </div>
      <div v-for="entry in breakdown.roles" :key="entry.name" class="stat">
        <div class="stat-figure text-primary">
          <component :is="roleIcon(entry.name)" class="size-7" />
        </div>
        <div class="stat-title capitalize">{{ entry.name }}</div>
        <div class="stat-value text-3xl">{{ entry.count }}</div>
      </div>
      <div class="stat">
        <div class="stat-figure opacity-40"><CircleSlash2 class="size-7" /></div>
        <div class="stat-title">{{ t('accounts.noRole') }}</div>
        <div class="stat-value text-3xl">{{ breakdown.none }}</div>
      </div>
    </div>

    <div v-if="error" role="alert" class="alert alert-error alert-soft">
      <CircleAlert class="size-4" />
      <span>{{ error }}</span>
    </div>

    <div v-if="loading" class="flex justify-center py-16">
      <span class="loading loading-spinner loading-lg"></span>
    </div>

    <div v-else class="card border-base-300 bg-base-200 border">
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('accounts.account') }}</th>
              <th>{{ t('accounts.role') }}</th>
              <th class="text-right">{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in visible" :key="user.id" class="hover:bg-base-300/40">
              <td>
                <div class="flex items-center gap-3">
                  <div class="avatar avatar-placeholder">
                    <div class="bg-neutral text-neutral-content w-9 rounded-full">
                      <span class="text-sm">{{ user.username.charAt(0).toUpperCase() }}</span>
                    </div>
                  </div>
                  <div>
                    <div class="font-medium">{{ user.username }}</div>
                    <div class="text-xs opacity-50">
                      {{ t('accounts.nodeCount', { count: user.nodes.length }, user.nodes.length) }}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <span
                  v-if="user.role"
                  class="badge badge-primary badge-soft badge-sm gap-1 capitalize"
                >
                  <component :is="roleIcon(user.role)" class="size-3" />
                  {{ user.role }}
                </span>
                <span v-else class="badge badge-ghost badge-sm gap-1 opacity-70">
                  <CircleSlash2 class="size-3" />
                  {{ t('common.none') }}
                </span>
              </td>
              <td>
                <div class="flex justify-end gap-1">
                  <button
                    v-if="auth.can('user.edit') && user.username !== auth.user?.username"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="openEdit(user)"
                  >
                    <SquarePen class="size-3.5" />
                    {{ t('common.edit') }}
                  </button>
                  <button
                    v-if="auth.can('user.role.write') && user.username !== auth.user?.username"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="openRole(user)"
                  >
                    <UserRoundCog class="size-3.5" />
                    {{ t('accounts.changeRole') }}
                  </button>
                  <button
                    v-if="auth.can('user.delete') && user.username !== auth.user?.username"
                    class="btn btn-ghost btn-xs text-error gap-1"
                    @click="remove(user)"
                  >
                    <Trash2 class="size-3.5" />
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="visible.length === 0">
              <td colspan="3">
                <div class="flex flex-col items-center gap-2 py-10 opacity-60">
                  <Users class="size-6" />
                  <span class="text-sm">{{ t('accounts.noMatches') }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <dialog id="create-user" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <UserPlus class="text-primary size-5" />
          {{ t('accounts.newAccount') }}
        </h3>
        <ul class="steps mt-4 w-full">
          <li class="step step-primary text-xs">{{ t('accounts.account') }}</li>
          <li class="step text-xs" :class="createStep === 2 ? 'step-primary' : ''">{{ t('accounts.role') }}</li>
        </ul>

        <form class="mt-5 flex flex-col gap-4" @submit.prevent="submitCreate">
          <template v-if="createStep === 1">
            <FormField
              v-model="draft.username"
              :label="t('accounts.username')"
              :icon="UserRound"
              type="text"
              maxlength="64"
              required
            />
            <FormField
              v-model="draft.password"
              :label="t('accounts.password')"
              :placeholder="t('accounts.passwordPlaceholder')"
              :icon="KeyRound"
              type="password"
              autocomplete="new-password"
              minlength="4"
              maxlength="72"
              required
            />
            <FormField
              v-model="draft.confirmPassword"
              :label="t('accounts.confirmPassword')"
              :placeholder="t('accounts.confirmPlaceholder')"
              :icon="CheckCheck"
              :invalid="Boolean(draft.confirmPassword) && draft.confirmPassword !== draft.password"
              type="password"
              autocomplete="new-password"
              required
            />
          </template>

          <template v-else>
            <p class="text-sm opacity-60">
              {{ t('accounts.roleHint') }}
            </p>
            <ul class="flex flex-col gap-1">
              <li v-for="role in roles" :key="role.id">
                <label
                  class="rounded-field hover:bg-base-300/50 flex cursor-pointer items-start gap-3 p-3"
                >
                  <input
                    v-model="draft.role"
                    type="radio"
                    name="create-role"
                    class="radio radio-sm radio-primary mt-0.5 shrink-0"
                    :value="role.name"
                  />
                  <component :is="roleIcon(role.name)" class="text-primary mt-0.5 size-5 shrink-0" />
                  <span class="min-w-0 flex-1">
                    <span class="block font-medium capitalize">{{ role.name }}</span>
                    <span class="block text-xs opacity-60">
                      {{ role.nodes.map(nodeLabel).join(', ') }}
                    </span>
                  </span>
                </label>
              </li>
              <li>
                <label
                  class="rounded-field hover:bg-base-300/50 flex cursor-pointer items-start gap-3 p-3"
                >
                  <input
                    v-model="draft.role"
                    type="radio"
                    name="create-role"
                    class="radio radio-sm mt-0.5 shrink-0"
                    :value="null"
                  />
                  <CircleSlash2 class="mt-0.5 size-5 shrink-0 opacity-40" />
                  <span class="min-w-0 flex-1">
                    <span class="block font-medium">{{ t('accounts.noRole') }}</span>
                    <span class="block text-xs opacity-60">{{ t('accounts.noRoleHint') }}</span>
                  </span>
                </label>
              </li>
            </ul>
          </template>

          <div v-if="createError" role="alert" class="alert alert-error alert-soft">
            <CircleAlert class="size-4" />
            <span>{{ createError }}</span>
          </div>

          <div class="modal-action">
            <button
              v-if="createStep === 2"
              class="btn btn-ghost btn-sm gap-1"
              type="button"
              @click="createStep = 1"
            >
              <ChevronLeft class="size-4" />
              {{ t('accounts.back') }}
            </button>
            <button
              v-else
              class="btn btn-ghost btn-sm"
              type="button"
              @click="dialog('create-user')?.close()"
            >
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-primary btn-sm gap-1" type="submit">
              {{ createStep === 1 ? t('accounts.next') : t('accounts.create') }}
              <ChevronRight v-if="createStep === 1" class="size-4" />
            </button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog id="edit-user" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <SquarePen class="text-primary size-5" />
          {{ t('accounts.editTitle', { name: editingUser?.user.username }) }}
        </h3>
        <p class="mt-1 text-sm opacity-60">
          {{ t('accounts.renameWarning') }}
        </p>
        <form v-if="editingUser" class="mt-5 flex flex-col gap-4" @submit.prevent="saveUser">
          <FormField
            v-model="editingUser.username"
            :label="t('accounts.username')"
            :icon="UserRound"
            type="text"
            maxlength="64"
            required
          />
          <FormField
            v-model="editingUser.password"
            :label="t('accounts.newPassword')"
            :placeholder="t('accounts.passwordOptional')"
            :icon="KeyRound"
            type="password"
            autocomplete="new-password"
            minlength="4"
            maxlength="72"
          />
          <FormField
            v-model="editingUser.confirmPassword"
            :label="t('accounts.confirmNewPassword')"
            :placeholder="t('accounts.confirmNewPlaceholder')"
            :icon="CheckCheck"
            :invalid="editingUser.confirmPassword !== editingUser.password"
            type="password"
            autocomplete="new-password"
            :disabled="!editingUser.password"
          />
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('edit-user')?.close()">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-primary btn-sm" type="submit">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog id="edit-role" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <UserRoundCog class="text-primary size-5" />
          Role for {{ editing?.user.username }}
        </h3>
        <p class="mt-1 text-sm opacity-60">
          {{ t('accounts.roleHint') }}
        </p>
        <form class="mt-4 flex flex-col gap-3" @submit.prevent="saveRole">
          <ul v-if="editing" class="flex flex-col gap-1">
            <li v-for="role in roles" :key="role.id">
              <label
                class="rounded-field hover:bg-base-300/50 flex cursor-pointer items-start gap-3 p-3"
              >
                <input
                  v-model="editing.role"
                  type="radio"
                  name="role"
                  class="radio radio-sm radio-primary mt-0.5 shrink-0"
                  :value="role.name"
                />
                <component
                  :is="roleIcon(role.name)"
                  class="text-primary mt-0.5 size-5 shrink-0"
                />
                <span class="min-w-0 flex-1">
                  <span class="block font-medium capitalize">{{ role.name }}</span>
                  <span class="block text-xs opacity-60">
                    {{ role.nodes.map(nodeLabel).join(', ') }}
                  </span>
                </span>
              </label>
            </li>
            <li>
              <label
                class="rounded-field hover:bg-base-300/50 flex cursor-pointer items-start gap-3 p-3"
              >
                <input
                  v-model="editing.role"
                  type="radio"
                  name="role"
                  class="radio radio-sm mt-0.5 shrink-0"
                  :value="null"
                />
                <CircleSlash2 class="mt-0.5 size-5 shrink-0 opacity-40" />
                <span class="min-w-0 flex-1">
                  <span class="block font-medium">{{ t('accounts.noRole') }}</span>
                  <span class="block text-xs opacity-60">{{ t('accounts.removeRoleHint') }}</span>
                </span>
              </label>
            </li>
          </ul>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('edit-role')?.close()">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-primary btn-sm" type="submit">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>
</template>
