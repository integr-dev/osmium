<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Backpack, TriangleAlert } from 'lucide-vue-next'
import AlertNote from './AlertNote.vue'
import { t } from '../i18n'
import { useAgentStore, type AgentInventory } from '../stores/agents'
import { useAuthStore } from '../stores/auth'
import { iconFor, loadIcons } from '../lib/itemIcons'
import InventorySquare from './InventorySquare.vue'
import SlotActions from './SlotActions.vue'
import type { InventorySlotResponse } from '../api/client'

/**
 * What an agent is carrying, and the three things that can be done about it.
 *
 * Grouped the way Minecraft groups it — the twenty-seven, the nine set apart below them, the worn
 * things together — because an operator reading this has the game's own screen in their head, and a
 * grid in any other order is one they have to translate. The slot numbers underneath are the game's
 * too, so what is drawn in a square and what a click sends about it cannot disagree.
 *
 * **Moving is a drag, and only a drag.** It was two clicks as well, sharing one selection with the
 * panel - which meant that clicking two squares in a row moved an item, and every click was
 * therefore half of a move somebody might not have meant to start. A drag says what it is doing
 * while it is doing it and is abandoned by letting go somewhere else; a click now only ever opens
 * the panel for the square under it.
 */
const props = defineProps<{
  agentId: number
  /** Whether the agent is in the game. Nothing can be moved in a window that is not open. */
  online: boolean
}>()

const building = computed(() => agentStore.workOf(props.agentId))

const agentStore = useAgentStore()
const auth = useAuthStore()

/**
 * Whatever went wrong last, shown in the card rather than in the corner.
 *
 * A failed move is about the squares somebody is looking at, so it belongs beside them — and a
 * toast that outlives the card would be a notice about a screen nobody has open any more.
 */
const error = ref<string | null>(null)

/** Minecraft's own numbering, in the player window. */
const ARMOUR = [5, 6, 7, 8]
const OFFHAND = 45
const MAIN = Array.from({ length: 27 }, (_, at) => 9 + at)
const HOTBAR = Array.from({ length: 9 }, (_, at) => 36 + at)

/** Whether a square is one of the nine an agent can hold. Mirrors the host's own rule. */
function holdable(slot: number): boolean {
  return HOTBAR.includes(slot)
}

const inventory = computed<AgentInventory | null>(() => agentStore.inventoryOf(props.agentId))

/** By slot, so drawing a square is a lookup rather than a scan of forty entries. */
const bySlot = computed(() => {
  const found = new Map<number, InventorySlotResponse>()
  for (const item of inventory.value?.slots ?? []) found.set(item.slot, item)
  return found
})

/** Which square the agent has in hand, as a slot rather than as a hotbar index. */
const heldSlot = computed(() => (inventory.value ? HOTBAR[inventory.value.held] : undefined))

/**
 * The ring that says which square is in hand, and travels between them.
 *
 * The same measure-and-translate as `TabBar`, and it is here rather than shared with it because
 * the two agree on nothing but the idea: that marker is a background a tab sits on and is sized to
 * the tab it fills, this one is a ring drawn over a square that is already there. What they share
 * is the reason - a border on each square can only appear here and vanish there, and switching hand
 * is a movement along the bar.
 */
const hotbar = ref<HTMLElement | null>(null)
const ring = ref({ x: 0, y: 0, width: 0, height: 0 })

/** Off until it has been measured, so it never slides in from the first square on open. */
const ringPlaced = ref(false)

/**
 * Measured off the laid-out squares rather than computed from the grid.
 *
 * `data-slot` rather than a ref per square: the numbers are this application's own, never anything
 * a server names, and reading one attribute is less machinery than keeping nine element refs in
 * step. The container's own border is taken off both axes because an absolutely positioned child is
 * placed against the padding box while `getBoundingClientRect` reports the border box - the same
 * few pixels the tab marker was out by before it did this.
 */
function measureRing(): void {
  const container = hotbar.value
  const slot = heldSlot.value
  // The button, not the cell it sits in. A grid track is a fraction of the row and the square is a
  // fixed size inside it, so the two boxes agree to within a rounding error - and a ring that is a
  // rounding error too wide is a ring that does not sit on the square it is pointing at.
  const square =
    slot === undefined ? null : container?.querySelector<HTMLElement>(`[data-slot="${slot}"] > button`)
  if (!container || !square) {
    ringPlaced.value = false
    return
  }

  const strut = container.getBoundingClientRect()
  const box = square.getBoundingClientRect()

  ring.value = {
    x: box.left - strut.left - container.clientLeft,
    y: box.top - strut.top - container.clientTop,
    width: box.width,
    height: box.height,
  }
  ringPlaced.value = true
}

/** After the DOM has the change: every number here comes off the laid-out squares. */
async function remeasureRing(): Promise<void> {
  await nextTick()
  measureRing()
}

// The hand moving is the whole point; the inventory arriving is what puts the squares there to
// measure in the first place.
watch([heldSlot, inventory], remeasureRing)

let squares: ResizeObserver | null = null

onMounted(() => {
  void remeasureRing()
  // The card is beside the nearby list in a grid that reflows, and the sidebar can be dragged.
  squares = new ResizeObserver(() => measureRing())
  if (hotbar.value) squares.observe(hotbar.value)
})

onBeforeUnmount(() => squares?.disconnect())

/** Where the ring sits. Translated rather than offset, so it is the one thing that animates. */
const ringStyle = computed(() => ({
  translate: `${ring.value.x}px ${ring.value.y}px`,
  width: `${ring.value.width}px`,
  height: `${ring.value.height}px`,
}))

/**
 * The sprite sheet, once it arrives.
 *
 * Failing to load it is not failing to show an inventory: the squares still carry names, counts and
 * durability, so it is said in the card's own notice rather than in place of the card.
 */
const sheet = ref<Awaited<ReturnType<typeof loadIcons>> | null>(null)
void loadIcons()
  .then((loaded) => (sheet.value = loaded))
  .catch(() => (error.value = t('errors.itemIcons')))

/** The square whose panel is open, or null. Nothing about this is a half-finished move. */
const picked = ref<number | null>(null)

/**
 * The grid, so a click can be asked whether it landed inside it.
 *
 * A panel that only closes by pressing the same square again is a panel people leave open. Anywhere
 * else on the page is an unambiguous "not that, then".
 */
const grid = ref<HTMLElement | null>(null)

function elsewhere(event: MouseEvent): void {
  if (picked.value === null) return
  // `composedPath` rather than `contains`, so a click that starts on something the click handler
  // removes - a Drop button, once the panel closes - is still recognised as having been inside.
  if (!event.composedPath().includes(grid.value as EventTarget)) picked.value = null
}

function dismiss(event: KeyboardEvent): void {
  if (event.key === 'Escape') picked.value = null
}

// On the document, because the point is the clicks this component never sees. Capture phase so it
// runs before anything that stops propagation on its way up.
document.addEventListener('pointerdown', elsewhere, true)
document.addEventListener('keydown', dismiss)
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', elsewhere, true)
  document.removeEventListener('keydown', dismiss)
})

/**
 * The square a drag started from, which is the only thing that ever moves an item.
 *
 * Kept apart from {@link picked} on purpose. They were one value, so opening a panel armed a move
 * and the next click anywhere finished it.
 */
const dragging = ref<number | null>(null)

const pickedItem = computed(() => (picked.value === null ? null : (bySlot.value.get(picked.value) ?? null)))

/**
 * Anything in flight, which disables the whole grid rather than one square.
 *
 * A move is fire and forget and the answer arrives as a whole new inventory, so a second click in
 * that window is a click against squares that are about to be renumbered.
 */
const busy = ref(false)

/**
 * Why the squares do nothing, or null when they do.
 *
 * Building is the one of the three that is temporary and that the operator caused. What an agent
 * is carrying while it builds *is* the build - moving a stack out of the square it places from
 * leaves it putting the wrong block somewhere, and the damage surfaces minutes later as a wall
 * with holes in it. The backend refuses these outright; saying so here is what stops an operator
 * finding out by having a click fail.
 */
const blocked = computed<string | null>(() => {
  if (!auth.can('agent.run')) return t('inventory.blockedPermission')
  if (!props.online) return t('inventory.blockedOffline')
  if (building.value) return t('inventory.blockedBuilding')
  return null
})

// A panel is about a square with something in it, or a hotbar square that can be held. An agent
// that drops what the panel is open on, or leaves the game, leaves it describing nothing.
watch([pickedItem, blocked], () => {
  if (picked.value === null) return
  if (blocked.value || (!pickedItem.value && !holdable(picked.value))) picked.value = null
})

// Fetched once when the card opens. The live stream keeps it current afterwards — which for an
// agent standing still means never, hence this.
watch(
  () => props.agentId,
  (id) => void agentStore.loadInventory(id).catch(complain),
  { immediate: true },
)

/** What hovering a square says: the item, how many, how worn, and whether it is in hand. */
function label(slot: number): string {
  const item = bySlot.value.get(slot)
  const inHand = slot === heldSlot.value ? t('inventory.held') : null

  if (!item) return [t('inventory.empty'), inHand].filter(Boolean).join(' — ')

  const worn =
    item.maxDamage === null || item.damage === null
      ? null
      : t('inventory.durability', { left: item.maxDamage - item.damage, max: item.maxDamage })

  return [item.count > 1 ? `${item.displayName} x${item.count}` : item.displayName, worn, inHand]
    .filter(Boolean)
    .join(' — ')
}

function icon(slot: number) {
  const item = bySlot.value.get(slot)
  return item ? iconFor(sheet.value, item.name) : null
}

/**
 * A click on a square opens its panel, and nothing else.
 *
 * An empty hotbar square opens one too, because there is still something to do with it — an agent
 * can hold an empty hand, and which square that is decides what it hits, places and eats with. An
 * empty square anywhere else opens nothing: there would be no button to put in the panel.
 */
function tap(slot: number): void {
  if (blocked.value || busy.value) return

  const worth = bySlot.value.has(slot) || holdable(slot)
  picked.value = picked.value === slot || !worth ? null : slot
}

/**
 * Sends the move and waits for the report.
 *
 * Nothing is written locally. What the agent is carrying is the host's to say, and moving the item
 * on screen would show it done before the server had agreed — then disagree with the report.
 */
function move(from: number, to: number): void {
  void run(() => agentStore.moveItem(props.agentId, from, to))
}

/** Throws the picked square's contents. An absent count is the whole stack. */
function drop(count?: number): void {
  const slot = picked.value
  if (slot === null) return
  void run(() => agentStore.dropItem(props.agentId, slot, count))
}

/** Puts the picked square in the agent's hand. */
function hold(): void {
  const slot = picked.value
  if (slot === null) return
  void run(() => agentStore.holdItem(props.agentId, slot))
}

/** One command, with the grid disabled for the round trip and the selection let go after it. */
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return

  busy.value = true
  error.value = null
  try {
    await action()
    picked.value = null
  } catch (failure) {
    complain(failure)
  } finally {
    busy.value = false
  }
}

function complain(failure: unknown): void {
  error.value = failure instanceof Error ? failure.message : t('errors.commandFailed')
}

function startDrag(event: DragEvent, slot: number): void {
  if (blocked.value || busy.value || !bySlot.value.has(slot)) return event.preventDefault()

  dragging.value = slot
  // A panel that stayed open would follow the square rather than the item, and be about a square
  // whose contents are on their way somewhere else.
  picked.value = null
  event.dataTransfer?.setData('text/plain', String(slot))
}

/** A drag let go anywhere that is not a square. Nothing moves; the drag is simply over. */
function endDrag(): void {
  dragging.value = null
}

function release(slot: number): void {
  const from = dragging.value
  dragging.value = null
  if (blocked.value || busy.value || from === null || from === slot) return
  move(from, slot)
}
</script>

<template>
  <div class="card border-base-300 bg-base-200 border">
    <div class="card-body gap-4">
      <h2 class="card-title flex items-center gap-2 text-base">
        <Backpack class="text-base-content/50 size-4" />
        {{ t('inventory.title') }}
      </h2>

      <!--
        Absent, not empty. An empty grid is a perfectly ordinary thing for an agent to be carrying,
        so drawing one for an agent that has said nothing is not a blank screen but a wrong answer.
      -->
      <p v-if="!inventory" class="py-10 text-center text-sm opacity-50">{{ t('inventory.none') }}</p>

      <template v-else>
        <!--
          The game's own arrangement, in the game's own order: what is worn on top, then the
          twenty-seven, then the nine set apart at the bottom.

          Minecraft puts the armour in a column because it has a player model to stand beside; there
          is none here, so the four lie in a row with the off hand next to them. That keeps the block
          one row deep instead of four, which is what lets the whole card be about as wide as the
          nine squares and no wider.

          Fixed square sizes rather than a share of the row. Sized off the container the grid filled
          whatever it was given, which on a wide screen meant slots the size of a thumbnail; an
          inventory is read by recognising icons, and past a certain size that stops getting easier.
        -->
        <div ref="grid" class="flex w-[27.75rem] max-w-full flex-col gap-4">
          <div class="flex items-start gap-6">
            <div class="flex flex-col gap-2">
              <div class="text-xs uppercase opacity-50">{{ t('inventory.armour') }}</div>
              <div class="flex gap-1.5">
                <InventorySquare
                  v-for="slot in ARMOUR"
                  :key="slot"
                  :item="bySlot.get(slot)"
                  :icon="icon(slot)"
                  :label="label(slot)"
                  :picked="picked === slot"
                  :idle="blocked !== null"
                  :grabbable="blocked === null && bySlot.has(slot)"
                  :armed="dragging !== null"
                  @select="tap(slot)"
                  @grab="startDrag($event, slot)"
                  @dragend="endDrag()"
                  @release="release(slot)"
                >
                  <SlotActions
                    v-if="picked === slot"
                    :item="bySlot.get(slot)"
                    :busy="busy"
                    @hold="hold()"
                    @drop-one="drop(1)"
                    @drop-stack="drop()"
                  />
                </InventorySquare>
              </div>
            </div>

            <!-- Beside the armour, as it sits beside the boots in game. -->
            <div class="flex flex-col gap-2">
              <div class="text-xs uppercase opacity-50">{{ t('inventory.offhand') }}</div>
              <InventorySquare
                :item="bySlot.get(OFFHAND)"
                :icon="icon(OFFHAND)"
                :label="label(OFFHAND)"
                :picked="picked === OFFHAND"
                :idle="blocked !== null"
                :grabbable="blocked === null && bySlot.has(OFFHAND)"
                :armed="dragging !== null"
                @select="tap(OFFHAND)"
                @grab="startDrag($event, OFFHAND)"
                @dragend="endDrag()"
                @release="release(OFFHAND)"
              >
                <SlotActions
                  v-if="picked === OFFHAND"
                  :item="bySlot.get(OFFHAND)"
                  :busy="busy"
                  @hold="hold()"
                  @drop-one="drop(1)"
                  @drop-stack="drop()"
                />
              </InventorySquare>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <div class="text-xs uppercase opacity-50">{{ t('inventory.main') }}</div>
            <div class="grid max-w-[27.75rem] grid-cols-9 gap-1.5">
              <InventorySquare
                v-for="slot in MAIN"
                :key="slot"
                :item="bySlot.get(slot)"
                :icon="icon(slot)"
                :label="label(slot)"
                :picked="picked === slot"
                :idle="blocked !== null"
                :grabbable="blocked === null && bySlot.has(slot)"
                :armed="dragging !== null"
                @select="tap(slot)"
                @grab="startDrag($event, slot)"
                @dragend="endDrag()"
                @release="release(slot)"
              >
                <SlotActions
                  v-if="picked === slot"
                  :item="bySlot.get(slot)"
                  :busy="busy"
                  @hold="hold()"
                  @drop-one="drop(1)"
                  @drop-stack="drop()"
                />
              </InventorySquare>
            </div>

            <!--
              Set apart from the twenty-seven above it, as the game sets it apart, because it is a
              different thing: these nine are what the agent can reach without opening anything.

              The square in hand is ringed; the square whose panel is open is filled. One is a fact
              about the agent and the other is where somebody is looking, and on one grid they must
              not look alike.
            -->
            <div class="mt-1 text-xs uppercase opacity-50">{{ t('inventory.hotbar') }}</div>
            <div ref="hotbar" class="relative grid max-w-[27.75rem] grid-cols-9 gap-1.5">
              <!--
                Which square is in hand, as one ring that travels rather than nine that take turns.
                After the squares in the DOM so it paints over them: neither carries a stacking
                order, which leaves document order to decide.
              -->
              <span
                aria-hidden="true"
                class="osmium-held-marker"
                :class="ringPlaced ? '' : 'osmium-held-marker-idle'"
                :style="ringStyle"
              ></span>

              <InventorySquare
                v-for="slot in HOTBAR"
                :key="slot"
                :data-slot="slot"
                :item="bySlot.get(slot)"
                :icon="icon(slot)"
                :label="label(slot)"
                :picked="picked === slot"
                :held="slot === heldSlot"
                :idle="blocked !== null"
                :grabbable="blocked === null && bySlot.has(slot)"
                :armed="dragging !== null"
                @select="tap(slot)"
                @grab="startDrag($event, slot)"
                @dragend="endDrag()"
                @release="release(slot)"
              >
                <SlotActions
                  v-if="picked === slot"
                  :item="bySlot.get(slot)"
                  holdable
                  :held="slot === heldSlot"
                  :busy="busy"
                  @hold="hold()"
                  @drop-one="drop(1)"
                  @drop-stack="drop()"
                />
              </InventorySquare>
            </div>
          </div>
        </div>

        <p v-if="blocked" class="flex items-center gap-2 text-xs opacity-50">
          <TriangleAlert class="size-3.5 shrink-0" />
          {{ blocked }}
        </p>
      </template>

      <AlertNote v-if="error" kind="error" :message="error" />
    </div>
  </div>
</template>
