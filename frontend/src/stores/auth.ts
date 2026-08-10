import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, errorMessage, isUnreachable, type UserResponse } from '../api/client'
import { token } from '../api/token'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserResponse | null>(null)
  const isAuthenticated = computed(() => token.value !== null)

  /**
   * Whether the account holds a permission node. Mirrors the backend's @PreAuthorize checks, so
   * the UI hides exactly what the API would reject.
   */
  function can(node: string): boolean {
    return user.value?.nodes?.includes(node) ?? false
  }

  async function login(username: string, password: string): Promise<void> {
    const { data, error } = await api.POST('/api/auth/login', {
      body: { username, password },
    })
    if (error || !data?.token) throw new Error(errorMessage(error, 'Invalid username or password'))

    token.value = data.token
    await loadUser()
  }

  async function loadUser(): Promise<void> {
    const { data, error } = await api.GET('/api/auth/me')
    if (error || !data) {
      // An unreachable backend says nothing about the account, so the cached one is kept: wiping it
      // blanked the username and role on My Account whenever the backend was merely down.
      if (isUnreachable(error)) return
      // A valid token without user.read.self still counts as signed in; leave the session alone.
      user.value = null
      return
    }
    user.value = data as UserResponse
  }

  /** Loads the account once, so route guards can check nodes after a reload. */
  async function ensureLoaded(): Promise<void> {
    if (!isAuthenticated.value || user.value) return
    await loadUser()
  }

  function logout(): void {
    token.value = null
    user.value = null
  }

  return { user, isAuthenticated, can, login, loadUser, ensureLoaded, logout }
})
