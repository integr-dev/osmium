<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Icon } from '../lib/itemIcons'
import type { InventorySlotResponse } from '../api/client'

/**
 * One square of an agent's inventory.
 *
 * Its own component because the game's screen puts these in four differently shaped blocks — a row
 * of four, a lone one, a nine-by-three and a row of nine — and writing the square once is what
 * keeps the hotbar from quietly drifting away from the rest.
 *
 * It decides nothing. What is in it, whether it is picked up, whether it is in hand and whether it
 * can be touched at all are the card's to know; this draws them.
 */
const props = defineProps<{
  /** What is in the square, or nothing. */
  item?: InventorySlotResponse
  /** Where its picture sits on the sprite sheet, once that has loaded. */
  icon?: Icon | null
  /** What hovering it says: the item, how many, how worn, whether it is in hand. */
  label: string
  /** The operator has this square picked up. */
  picked?: boolean
  /** The agent is holding this square. */
  held?: boolean
  /** Nothing here can be moved — no session, or no permission. */
  idle?: boolean
  /** Whether a drag may start here, which is only true of a square with something in it. */
  grabbable?: boolean
  /**
   * A drag is in flight somewhere on the grid.
   *
   * Needed to tell "an item is being dragged over me" from "a file from the desktop is passing
   * over me", which look identical from a `dragenter` and only one of which this can accept.
   */
  armed?: boolean
}>()

const emit = defineEmits<{
  select: []
  grab: [event: DragEvent]
  /** The drag ended, wherever it ended. Whoever started it has to stop expecting a drop. */
  dragend: []
  release: []
}>()

/**
 * How much life is left, as a fraction, or null for something that does not wear out.
 *
 * Both halves or neither: an item carrying a maximum and no reading is one whose wear nobody knows,
 * and drawing a full bar for it would be inventing the answer.
 */
const wear = computed(() => {
  const item = props.item
  if (!item || item.maxDamage === null || item.damage === null || item.maxDamage <= 0) return null
  return Math.max(0, Math.min(1, (item.maxDamage - item.damage) / item.maxDamage))
})

/**
 * Whether a drag is currently over this square.
 *
 * Held here rather than by the card, because `dragleave` on one square and `dragenter` on the next
 * arrive in that order but are two events - a single "which square" up in the parent flickers off
 * and on again between them. Each square knowing only about itself cannot flicker.
 */
const over = ref(false)

function enter(): void {
  if (props.armed) over.value = true
}

function leave(): void {
  over.value = false
}

function drop(): void {
  over.value = false
  emit('release')
}

/** The three background properties that put one tile of the sheet in this square. */
const sprite = computed(() =>
  props.icon
    ? {
        backgroundImage: `url(${props.icon.url})`,
        backgroundSize: props.icon.size,
        backgroundPosition: props.icon.position,
      }
    : undefined,
)
</script>

<template>
  <!--
    A wrapper, so that whatever is put in the slot below can hang outside the square.

    The square itself clips its own overflow - that is what keeps a sprite inside it - so a panel
    anchored to it has to be a sibling rather than a child. A sibling also keeps it out of the
    button, which is the difference between a panel with buttons in it and invalid markup.
  -->
  <div class="relative">
    <button
      type="button"
      class="square"
      :class="{ picked, held, idle, target: armed && over }"
      :draggable="grabbable"
      :disabled="idle"
      :title="label"
      @click="$emit('select')"
      @dragstart="$emit('grab', $event)"
      @dragend="$emit('dragend')"
      @dragenter="enter()"
      @dragleave="leave()"
      @dragover.prevent
      @drop.prevent="drop()"
    >
      <span v-if="sprite" class="pixels absolute inset-[4px]" :style="sprite"></span>
      <!--
        An item the sheet has never heard of is still an item somebody has to decide about, so it
        gets its name rather than an empty square.
      -->
      <span v-else-if="item" class="line-clamp-3 px-1 text-center text-[0.6rem] leading-tight break-words opacity-70">
        {{ item.displayName }}
      </span>

      <span v-if="item && item.count > 1" class="count">{{ item.count }}</span>

      <span v-if="wear !== null" class="wear">
        <span class="wear-left" :style="{ width: `${wear * 100}%` }"></span>
      </span>
    </button>

    <slot />
  </div>
</template>

<style scoped>
/*
 * A fixed size, not a share of whatever row it lands in.
 *
 * It was briefly sized off its container, so that the grid would fill the card. What that produced
 * was slots the size of a thumbnail on a wide screen: an inventory is read by recognising icons, and
 * past a certain size that stops getting easier while the card gets three times as tall.
 *
 * 2.75rem is a little over the 2.25rem this started at — enough that a 16-pixel sprite is drawn at
 * nearly triple size and the stack counts sit comfortably, without the block outgrowing the page.
 */
.square {
  position: relative;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: var(--radius-field, 0.25rem);
  background-color: color-mix(in oklab, var(--color-base-300) 55%, transparent);
  border: 1px solid color-mix(in oklab, var(--color-base-content) 8%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

.square:not(.idle):hover {
  border-color: color-mix(in oklab, var(--color-base-content) 30%, transparent);
}

.square.idle {
  cursor: default;
}

/* What an operator picked up. Filled, because it is a thing being held. */
.square.picked {
  background-color: color-mix(in oklab, var(--color-primary) 30%, transparent);
  border-color: var(--color-primary);
}

/*
 * Where a dragged item would land.
 *
 * Loud on purpose, and louder than either of the states below it. Those two describe how things
 * are; this one is the answer to a question somebody is asking right now, with an item held over
 * the grid and half a second to read it. A one-pixel border change was not visible at all.
 */
.square.target {
  background-color: color-mix(in oklab, var(--color-primary) 45%, transparent);
  border-color: var(--color-primary);
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

/*
 * What the agent is holding.
 *
 * **The ring is not drawn here.** It is one element that travels across the hotbar - see
 * `.osmium-held-marker` - because switching hand is a movement along the bar, and a border on each
 * square can only appear here and vanish there. What is left on the square itself is the hint of
 * warm colour under it, which is what stops the travelling ring looking like it is floating over an
 * unrelated square mid-slide.
 */
.square.held {
  background-color: color-mix(in oklab, var(--color-warning) 12%, transparent);
}

/*
 * Sprites are 16 pixels across and are drawn at more than twice that. Smoothing turns a face into a
 * smudge, which is the one thing a Minecraft icon must not be.
 */
.pixels {
  background-repeat: no-repeat;
  image-rendering: pixelated;
}

/*
 * The stack count, over the icon it belongs to.
 *
 * Read against whatever the sprite happens to be behind it, which is every colour there is - a
 * light number on a snow block and a dark one on obsidian are the same problem twice. So it gets
 * its own ground rather than its own colour: a small plate of the card's own background, which
 * puts the text back on a surface the theme already guarantees is readable.
 *
 * It was a text shadow, on the theory that an outline is cheaper than a box. Four shadows deep it
 * was still mushy against a busy 16-pixel texture, because a one-pixel halo around a two-pixel
 * stroke is not contrast, it is a slightly different smudge.
 */
.count {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
  color: var(--color-base-content);
  background-color: color-mix(in oklab, var(--color-base-100) 88%, transparent);
}

/* The game's own durability bar: across the bottom of the square, and it empties as it wears. */
/*
 * Never fights the stack count for the same corner: an item that wears out does not stack, so a
 * square shows one or the other and never both.
 */
.wear {
  position: absolute;
  inset-inline: 3px;
  bottom: 3px;
  height: 3px;
  border-radius: 2px;
  background-color: color-mix(in oklab, var(--color-base-content) 45%, transparent);
  overflow: hidden;
}

.wear-left {
  display: block;
  height: 100%;
  background-color: color-mix(in oklab, var(--color-success) 85%, var(--color-error));
}
</style>
