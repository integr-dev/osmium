import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { ChatMessageResponse } from '../api/client'
import { belongsTo, parseScopeKey, scopeKey, type ChatScope } from '../lib/chat'
import { useAgentStore } from './agents'

const OPEN_KEY = 'osmium.chat.open'
const SCOPE_KEY = 'osmium.chat.scope'

/**
 * The chat rail: whether it is showing, what it is showing, and how much has been said while it was
 * not.
 *
 * Rail state rather than panel state, because it outlives every view. Kept in the store instead of
 * in `AppLayout` so the dashboard and the agent page can point it somewhere without the layout
 * having to hand callbacks down to them.
 */
export const useChatStore = defineStore('chat', () => {
  const open = ref(localStorage.getItem(OPEN_KEY) === 'true')
  const scope = ref<ChatScope | null>(parseScopeKey(localStorage.getItem(SCOPE_KEY)))

  /**
   * Lines that arrived while the rail was shut.
   *
   * Counted against the scope the rail would have opened on, so the badge means "there is something
   * to read here" rather than "a server you are not watching is busy". Before anything has been
   * picked, every line counts — there is no scope to be wrong about yet.
   */
  const unread = ref(0)

  // Never unsubscribed: the store lives as long as the app, and dropping it would silence the badge
  // for the rest of the session.
  useAgentStore().onFeedEvent((name, data) => {
    if (name !== 'chat' || open.value) return
    const line = data as ChatMessageResponse
    if (!scope.value || belongsTo(line, scope.value)) unread.value += 1
  })

  watch(open, (value) => localStorage.setItem(OPEN_KEY, String(value)))
  watch(scope, (value) => {
    if (value) localStorage.setItem(SCOPE_KEY, scopeKey(value))
    else localStorage.removeItem(SCOPE_KEY)
  })

  /** Opening, or changing what is shown, is the same gesture: you are now looking at it. */
  function show(next: ChatScope): void {
    scope.value = next
    open.value = true
    unread.value = 0
  }

  function toggle(): void {
    open.value = !open.value
    if (open.value) unread.value = 0
  }

  function close(): void {
    open.value = false
  }

  return { open, scope, unread, show, toggle, close }
})
