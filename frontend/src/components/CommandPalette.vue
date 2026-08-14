<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Bot as Agent, CornerDownLeft, Search, Server, TriangleAlert, Zap } from 'lucide-vue-next'
import { buildCommands, rank, type Command, type CommandSection } from '../lib/commands'
import { isShortcut } from '../lib/shortcuts'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'

/**
 * Ctrl/⌘-K: go anywhere, or act on an agent, without reaching for the mouse.
 *
 * The list is rebuilt every time it opens rather than cached — the fleet moves underneath it, and a
 * stale list would offer to connect an agent that is already online. Ranking and gating live in
 * `src/lib/commands.ts`, which is where the tests are.
 */
const { t } = useI18n()
const router = useRouter()
const agentStore = useAgentStore()
const auth = useAuthStore()
const chat = useChatStore()

const dialog = ref<HTMLDialogElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const active = ref(0)
const commands = ref<Command[]>([])
const error = ref<string | null>(null)

const results = computed(() => rank(commands.value, query.value).slice(0, MAX_RESULTS))

/**
 * Grouped for display only; the ranking itself is global, so a strong match never sinks under a
 * heading. Grouping does reorder, though — so each row carries the index the arrow keys use, worked
 * out here in one pass rather than searched for per row at render time.
 */
const grouped = computed(() => {
  const sections: { section: CommandSection; items: { command: Command; index: number }[] }[] = []
  for (const command of results.value) {
    const existing = sections.find((group) => group.section === command.section)
    if (existing) existing.items.push({ command, index: 0 })
    else sections.push({ section: command.section, items: [{ command, index: 0 }] })
  }

  let index = 0
  for (const group of sections) for (const item of group.items) item.index = index++
  return sections
})

/** What the arrow keys walk. The grouping is a visual nicety laid over this order. */
const flat = computed(() => grouped.value.flatMap((group) => group.items.map((item) => item.command)))

const SECTION_ICON: Record<CommandSection, typeof Search> = {
  navigate: Search,
  agents: Agent,
  hosts: Server,
  actions: Zap,
}

const MAX_RESULTS = 40

function open() {
  commands.value = buildCommands({
    agents: agentStore.agents,
    hosts: agentStore.hosts,
    can: auth.can,
    hostReachable: (hostId) => agentStore.hostById(hostId)?.reachable === true,
    connect: agentStore.connect,
    disconnect: agentStore.disconnect,
    toggleChat: chat.toggle,
    logout: async () => {
      agentStore.disconnectLiveUpdates()
      await auth.logout()
      await router.push({ name: 'login' })
    },
  })
  query.value = ''
  active.value = 0
  error.value = null
  dialog.value?.showModal()
  // After the dialog is shown, or the browser has nothing focusable to give it to yet.
  requestAnimationFrame(() => input.value?.focus())
}

/** Typing rewinds to the top: the old highlight belongs to a list that no longer exists. */
watch(query, () => (active.value = 0))

/**
 * Keeps the highlighted row in view.
 *
 * The list scrolls and the arrow keys do not, so holding one walked the selection off the bottom of
 * the box and left the operator watching a list that had stopped moving. `nearest` rather than
 * `center`, so a row already on screen does not jerk the whole list to recentre it.
 */
const list = ref<HTMLElement | null>(null)

watch(active, async () => {
  await nextTick()
  list.value
    ?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)
    ?.scrollIntoView({ block: 'nearest' })
})

async function choose(command: Command | undefined) {
  if (!command) return
  error.value = null

  if (command.to) {
    dialog.value?.close()
    await router.push(command.to)
    return
  }

  try {
    await command.run?.()
    dialog.value?.close()
  } catch (failure) {
    // Kept open on failure, showing why. Closing would leave the operator with a command that
    // silently did nothing.
    error.value = failure instanceof Error ? failure.message : t('errors.commandFailed')
  }
}

function move(delta: number) {
  if (!flat.value.length) return
  // Wraps, so holding one arrow reaches everything without hunting for the other.
  active.value = (active.value + delta + flat.value.length) % flat.value.length
}

function onKeydown(event: KeyboardEvent) {
  // Prevented because both browsers bind Ctrl-K to their own address bar, and this is the more
  // specific claim while the app has focus.
  if (!isShortcut(event, 'K')) return
  event.preventDefault()
  if (dialog.value?.open) dialog.value.close()
  else open()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** So the sidebar hint opens the same palette rather than duplicating any of this. */
defineExpose({ open })
</script>

<template>
  <!--
    Top-aligned rather than centred: a palette that grows downwards keeps its input under the
    cursor, where a centred one moves the thing being typed into as results arrive.
  -->
  <dialog ref="dialog" class="modal items-start">
    <!--
      The offset is a margin on the box, not padding on the modal. Padding sits outside the grid's
      content box, so the backdrop cannot reach into it — the top of the screen stopped dismissing
      the palette, which is the first place anyone clicks to get rid of it.

      Border and shadow stated outright. The theme runs `--depth: 0`, so daisyUI's box gives a modal
      no elevation at all — which is right for a dialog that fills the view, and wrong for a panel
      floating over a page the operator is still reading behind it.
    -->
    <div class="modal-box border-base-300 mt-[12vh] max-w-xl border p-0 shadow-2xl shadow-black/50">
      <label class="border-base-300 flex items-center gap-3 border-b px-4 py-3">
        <Search class="size-4 shrink-0 opacity-50" />
        <input
          ref="input"
          v-model="query"
          class="grow bg-transparent text-sm outline-none"
          type="text"
          :placeholder="t('palette.placeholder')"
          :aria-label="t('palette.placeholder')"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="choose(flat[active])"
        />
        <kbd class="kbd kbd-sm">esc</kbd>
      </label>

      <div v-if="error" role="alert" class="alert alert-error alert-soft m-3">
        <TriangleAlert class="size-4" />
        <span>{{ error }}</span>
      </div>

      <!--
        `scroll-py-4` is what stops a keyboard-scrolled row landing flush against the edge.
        `scrollIntoView` aligns to the scrollport, which ordinary padding is not part of — only
        scroll-padding insets it, so without this the highlight touches the border and reads as cut
        off. Larger than the box's own `p-2`, so the row above stays half in view and the list is
        visibly a list rather than a window that happens to start there.
      -->
      <div ref="list" class="max-h-[50vh] scroll-py-4 overflow-y-auto p-2">
        <template v-for="group in grouped" :key="group.section">
          <p class="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide uppercase opacity-40">
            {{ t(`palette.section.${group.section}`) }}
          </p>
          <button
            v-for="item in group.items"
            :key="item.command.id"
            :data-index="item.index"
            type="button"
            class="rounded-field flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left"
            :class="active === item.index ? 'bg-primary/15' : 'hover:bg-base-300/40'"
            @mousemove="active = item.index"
            @click="choose(item.command)"
          >
            <component :is="SECTION_ICON[item.command.section]" class="size-4 shrink-0 opacity-50" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ item.command.label }}</span>
              <span v-if="item.command.hint" class="block truncate font-mono text-xs opacity-50">
                {{ item.command.hint }}
              </span>
            </span>
            <CornerDownLeft v-if="active === item.index" class="size-3.5 shrink-0 opacity-40" />
          </button>
        </template>

        <p v-if="!flat.length" class="py-10 text-center text-sm opacity-50">
          {{ t('palette.noMatches') }}
        </p>
      </div>
    </div>

    <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
  </dialog>
</template>
