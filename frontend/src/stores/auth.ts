import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  api,
  errorMessage,
  isUnreachable,
  type SessionResponse,
  type UserResponse,
} from '../api/client'
import { endSession, refreshSession } from '../api/session'
import { token } from '../api/token'
import { clearAvatars } from '../lib/avatars'
import { t } from '../i18n'

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
    if (error || !data?.token) throw new Error(errorMessage(error, t('errors.invalidCredentials')))

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

  /**
   * Picks the session back up after a reload.
   *
   * The access token is gone — it only ever lived in memory — so it is re-minted from the refresh
   * cookie, which this code cannot read and does not need to.
   *
   * **Awaited by the route guard**, not merely before mounting. vue-router starts its initial
   * navigation inside `install()`, which is `app.use(router)` — before anything after that line has
   * run. Restoring at the app level therefore lost the race every time: the guard read a signed-out
   * store and redirected to the login screen, and a reload sent an operator with a perfectly good
   * session back to the password box.
   *
   * Memoised, so it costs one request per page load and not one per navigation. A signed-out
   * visitor gets a single 401 and is then left alone.
   */
  let restoring: Promise<void> | null = null

  function restore(): Promise<void> {
    restoring ??= (async () => {
      if (isAuthenticated.value) return
      if (await refreshSession()) await loadUser()
    })()
    return restoring
  }

  /**
   * When a refresh token for this account was replayed and the operator has not been shown it yet.
   *
   * The only route by which the person it happened to learns about it: the audit trail needs
   * `audit.read`, so it reaches an administrator and not them.
   */
  const sessionAlertAt = computed(() => user.value?.sessionAlertAt ?? null)

  async function dismissSessionAlert(): Promise<void> {
    // Cleared locally first: the banner should go on the click, and a failed acknowledgement means
    // it comes back on the next load, which is the right way round for a notice like this.
    if (user.value) user.value = { ...user.value, sessionAlertAt: null }
    await api.POST('/api/auth/session-alert/acknowledge')
  }

  /** The account's live sessions, newest first, with this browser's marked. */
  async function sessions(): Promise<SessionResponse[]> {
    const { data, error } = await api.GET('/api/auth/sessions')
    if (error || !data) throw new Error(errorMessage(error, t('errors.loadSessions')))
    return data as SessionResponse[]
  }

  /** Ends one session by id. Another account's is refused, and reads as not found. */
  async function endOtherSession(id: number): Promise<void> {
    const { error } = await api.DELETE('/api/auth/sessions/{id}', { params: { path: { id } } })
    if (error) throw new Error(errorMessage(error, t('sessions.failed')))
  }

  /**
   * Ends every session, this one included, and invalidates access tokens already issued.
   *
   * The local session is cleared whatever the call returns: this is the button someone presses when
   * they believe they are compromised, and leaving them signed in because the request was awkward
   * would be the worst possible reading of a failure.
   */
  async function endAllSessions(): Promise<void> {
    try {
      await api.POST('/api/auth/sessions/revoke-all')
    } finally {
      token.value = null
      user.value = null
      clearAvatars()
    }
  }

  /**
   * Ends the session at the backend as well as here. Without that the refresh cookie would outlive
   * the logout, and anyone reaching this browser afterwards could mint a fresh access token from it.
   */
  async function logout(): Promise<void> {
    await endSession()
    user.value = null
    // Heads were fetched as this account and are held as blob URLs; the next operator to sign in on
    // this machine should not inherit them.
    clearAvatars()
  }

  return {
    user,
    isAuthenticated,
    can,
    login,
    loadUser,
    ensureLoaded,
    restore,
    sessionAlertAt,
    dismissSessionAlert,
    sessions,
    endOtherSession,
    endAllSessions,
    logout,
  }
})
