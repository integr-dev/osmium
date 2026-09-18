<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { blockColour } from '../lib/blockColours'
import { blockId, blockName, isKnownBlock, searchBlocks } from '../lib/blockNames'

/**
 * Choosing a block by name, with suggestions.
 *
 * A combobox rather than a `<select>`, for two reasons that pull the same way. There are eleven
 * hundred blocks, which is far past what a dropdown can be scrolled through — and the list is
 * **not closed**: a schematic can name a block newer than the table, or from a mod, and refusing to
 * accept one would make the picker worse than the plain text box it replaces. So what is typed is
 * always allowed, and the suggestions are help rather than a gate.
 *
 * Every row carries its swatch and its raw id: the colour to recognise it by, the readable name to
 * choose by, and the id underneath because that is what is actually stored and sent to the host.
 */
const model = defineModel<string>({ required: true })

const props = withDefaults(
  defineProps<{
    placeholder?: string
    /** Shown as a hint when the box is empty, e.g. "leave it out". */
    emptyMeans?: string
    size?: 'xs' | 'sm'
    /** Offered first, before the whole catalogue — the blocks actually in this schematic. */
    prefer?: string[]
  }>(),
  { placeholder: '', emptyMeans: '', size: 'sm', prefer: () => [] },
)

const open = ref(false)
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

/**
 * Blocks in this schematic first, then everything else.
 *
 * Substituting a block usually means swapping one already in the build for something plain, so the
 * few dozen that are actually present are far likelier than the eleven hundred that are not.
 */
const suggestions = computed(() => {
  const typed = blockId(model.value).trim().toLowerCase()

  const near = props.prefer
    .map(blockId)
    .filter((id) => !typed || id.includes(typed) || blockName(id).toLowerCase().includes(typed))
    .map((id) => ({ id, name: blockName(id), here: true }))

  const seen = new Set(near.map((entry) => entry.id))
  const rest = searchBlocks(model.value, 12)
    .filter((match) => !seen.has(match.id))
    .map((match) => ({ ...match, here: false }))

  return [...near.slice(0, 6), ...rest].slice(0, 14)
})

/** What was typed, when it is not one of the suggestions. Accepted, and said to be unrecognised. */
const unknown = computed(() => {
  const value = blockId(model.value).trim()
  return value.length > 0 && !isKnownBlock(value)
})

watch(model, () => {
  active.value = 0
})

function choose(id: string) {
  model.value = id
  open.value = false
  input.value?.blur()
}

function move(by: number) {
  if (!open.value) {
    open.value = true
    return
  }
  const count = suggestions.value.length
  if (!count) return

  active.value = (active.value + by + count) % count
  void nextTick(() => {
    list.value?.querySelectorAll('li')[active.value]?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Shuts the list, but not before a click on it has landed.
 *
 * `blur` fires ahead of the `click` that caused it, so closing immediately would unmount the
 * option the pointer is on and swallow the selection. `mousedown.prevent` on the rows covers the
 * ordinary case; this covers a click that begins on a row and ends elsewhere.
 */
function closeSoon() {
  setTimeout(() => (open.value = false), 120)
}

function commit(event: KeyboardEvent) {
  // Enter takes the highlighted suggestion when the list is open, and otherwise leaves what was
  // typed alone — a block the table has never heard of has to survive being typed and confirmed.
  const picked = open.value ? suggestions.value[active.value] : undefined
  if (!picked) {
    open.value = false
    return
  }
  event.preventDefault()
  choose(picked.id)
}
</script>

<template>
  <div class="relative">
    <label class="input w-full" :class="size === 'xs' ? 'input-xs' : 'input-sm'">
      <span
        class="border-base-content/20 size-3 shrink-0 rounded-[3px] border"
        :style="{ background: model.trim() ? blockColour(model) : 'transparent' }"
      ></span>
      <input
        ref="input"
        v-model="model"
        type="text"
        class="min-w-0 grow"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        :aria-expanded="open"
        aria-autocomplete="list"
        :placeholder="placeholder"
        @focus="open = true"
        @input="open = true"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter="commit"
        @keydown.esc="open = false"
        @keydown.tab="open = false"
        @blur="closeSoon"
      />
    </label>

    <!--
      What was typed and what it will be called, when those differ. An unrecognised block is
      accepted and said to be unrecognised: the table lags the game, and a schematic can name a
      block it has never heard of.
    -->
    <p v-if="!model.trim() && emptyMeans" class="mt-1 text-xs opacity-50">{{ emptyMeans }}</p>
    <p v-else-if="unknown" class="text-warning/80 mt-1 text-xs">{{ blockName(model) }}</p>

    <ul
      v-if="open && suggestions.length"
      ref="list"
      role="listbox"
      class="menu bg-base-100 rounded-box border-base-300 absolute z-50 mt-1 max-h-64 w-max min-w-full max-w-[min(26rem,80vw)] flex-nowrap overflow-y-auto border p-1 shadow-lg"
    >
      <li v-for="(entry, index) in suggestions" :key="entry.id" role="option">
        <button
          type="button"
          class="flex items-center gap-2"
          :class="index === active ? 'menu-active' : ''"
          @mousedown.prevent="choose(entry.id)"
          @mouseenter="active = index"
        >
          <span
            class="border-base-content/20 size-3.5 shrink-0 rounded-[3px] border"
            :style="{ background: blockColour(entry.id) }"
          ></span>
          <span class="shrink-0 text-left">{{ entry.name }}</span>
          <!-- Blocks already in this schematic, marked: they are the likely answer. -->
          <span v-if="entry.here" class="badge badge-ghost badge-xs shrink-0">{{ $t('builds.inThisBuild') }}</span>
          <span class="ms-auto min-w-0 truncate font-mono text-xs opacity-50">{{ entry.id }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
