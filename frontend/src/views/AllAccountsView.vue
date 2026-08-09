<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  CircleAlert,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRoundCog,
  Users,
} from 'lucide-vue-next'
import { api, errorMessage, type RoleResponse, type UserResponse } from '../api/client'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()

const users = ref<UserResponse[]>([])
const roles = ref<RoleResponse[]>([])
const error = ref<string | null>(null)
const loading = ref(true)
const query = ref('')

const draft = ref({ username: '', password: '', roles: [] as string[] })
const editing = ref<{ user: UserResponse; roles: string[] } | null>(null)

onMounted(async () => {
  await Promise.all([loadUsers(), loadRoles()])
  loading.value = false
})

function dialog(id: string): HTMLDialogElement | null {
  return document.getElementById(id) as HTMLDialogElement | null
}

function visible(): UserResponse[] {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return users.value
  return users.value.filter((user) => user.username.toLowerCase().includes(needle))
}

async function loadUsers() {
  const { data, error: failure } = await api.GET('/api/users')
  if (failure) {
    error.value = errorMessage(failure, 'Could not load accounts')
    return
  }
  users.value = (data ?? []) as UserResponse[]
}

async function loadRoles() {
  if (!auth.can('role.read')) return
  const { data } = await api.GET('/api/roles')
  roles.value = (data ?? []) as RoleResponse[]
}

async function createUser() {
  error.value = null
  const { error: failure } = await api.POST('/api/users', { body: draft.value })
  if (failure) {
    error.value = errorMessage(failure, 'Could not create the account')
    return
  }
  draft.value = { username: '', password: '', roles: [] }
  dialog('create-user')?.close()
  await loadUsers()
}

async function saveRoles() {
  if (!editing.value) return
  error.value = null
  const { error: failure } = await api.PUT('/api/users/{id}/roles', {
    params: { path: { id: editing.value.user.id } },
    body: { roles: editing.value.roles },
  })
  if (failure) {
    error.value = errorMessage(failure, 'Could not update roles')
    return
  }
  editing.value = null
  dialog('edit-roles')?.close()
  await loadUsers()
}

async function remove(user: UserResponse) {
  error.value = null
  const { error: failure } = await api.DELETE('/api/users/{id}', {
    params: { path: { id: user.id } },
  })
  if (failure) {
    error.value = errorMessage(failure, 'Could not delete the account')
    return
  }
  await loadUsers()
}

function openRoles(user: UserResponse) {
  editing.value = { user, roles: [...user.roles] }
  dialog('edit-roles')?.showModal()
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">All accounts</h1>
        <p class="text-sm opacity-60">
          {{ users.length }} account{{ users.length === 1 ? '' : 's' }}. Registration is
          administrator-only.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <label class="input input-sm w-56">
          <Search class="size-4 opacity-60" />
          <input v-model="query" type="search" placeholder="Filter by username" />
        </label>
        <button
          v-if="auth.can('user.create')"
          class="btn btn-primary btn-sm gap-2"
          @click="dialog('create-user')?.showModal()"
        >
          <Plus class="size-4" />
          New account
        </button>
      </div>
    </header>

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
              <th>Account</th>
              <th>Roles</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in visible()" :key="user.id" class="hover:bg-base-300/40">
              <td>
                <div class="flex items-center gap-3">
                  <div class="avatar avatar-placeholder">
                    <div class="bg-neutral text-neutral-content w-9 rounded-full">
                      <span class="text-sm">{{ user.username.charAt(0).toUpperCase() }}</span>
                    </div>
                  </div>
                  <div>
                    <div class="font-medium">{{ user.username }}</div>
                    <div class="text-xs opacity-50">{{ user.nodes.length }} nodes</div>
                  </div>
                </div>
              </td>
              <td>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="role in user.roles"
                    :key="role"
                    class="badge badge-primary badge-soft badge-sm gap-1"
                  >
                    <ShieldCheck class="size-3" />
                    {{ role }}
                  </span>
                  <span v-if="user.roles.length === 0" class="text-sm opacity-50">none</span>
                </div>
              </td>
              <td>
                <div class="flex justify-end gap-1">
                  <button
                    v-if="auth.can('user.roles.write')"
                    class="btn btn-ghost btn-xs gap-1"
                    @click="openRoles(user)"
                  >
                    <UserRoundCog class="size-3.5" />
                    Roles
                  </button>
                  <button
                    v-if="auth.can('user.delete') && user.username !== auth.user?.username"
                    class="btn btn-ghost btn-xs text-error gap-1"
                    @click="remove(user)"
                  >
                    <Trash2 class="size-3.5" />
                    Delete
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="visible().length === 0">
              <td colspan="3">
                <div class="flex flex-col items-center gap-2 py-10 opacity-60">
                  <Users class="size-6" />
                  <span class="text-sm">No accounts match that filter.</span>
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
          New account
        </h3>
        <form class="mt-4 flex flex-col gap-3" @submit.prevent="createUser">
          <input
            v-model="draft.username"
            class="input w-full"
            type="text"
            placeholder="Username"
            maxlength="64"
            required
          />
          <input
            v-model="draft.password"
            class="input w-full"
            type="password"
            placeholder="Password (4–72 characters)"
            minlength="4"
            maxlength="72"
            required
          />
          <div class="flex flex-wrap gap-4 pt-1">
            <label v-for="role in roles" :key="role.id" class="label cursor-pointer gap-2">
              <input
                v-model="draft.roles"
                type="checkbox"
                class="checkbox checkbox-sm checkbox-primary"
                :value="role.name"
              />
              <span class="label-text capitalize">{{ role.name }}</span>
            </label>
          </div>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('create-user')?.close()">
              Cancel
            </button>
            <button class="btn btn-primary btn-sm" type="submit">Create</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>

    <dialog id="edit-roles" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <UserRoundCog class="text-primary size-5" />
          Roles for {{ editing?.user.username }}
        </h3>
        <form class="mt-4 flex flex-col gap-3" @submit.prevent="saveRoles">
          <ul v-if="editing" class="list">
            <li v-for="role in roles" :key="role.id" class="list-row px-0">
              <div>
                <input
                  v-model="editing.roles"
                  type="checkbox"
                  class="checkbox checkbox-sm checkbox-primary"
                  :value="role.name"
                />
              </div>
              <div>
                <div class="font-medium capitalize">{{ role.name }}</div>
                <div class="text-xs opacity-60">{{ role.nodes.join(', ') }}</div>
              </div>
            </li>
          </ul>
          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" type="button" @click="dialog('edit-roles')?.close()">
              Cancel
            </button>
            <button class="btn btn-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>
  </div>
</template>
