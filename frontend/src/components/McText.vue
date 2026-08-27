<script setup lang="ts">
/**
 * One line of Minecraft chat, drawn the way the server styled it.
 *
 * The flattening and every judgement about what is safe to draw live in `lib/mcText`. This is only
 * the drawing: text goes in as text nodes — never `v-html` — and the only value that reaches a style
 * attribute is a colour that module produced.
 */
import { computed, onUnmounted, watch } from 'vue'

import { type Run, runsOf } from '../lib/mcText'
import { claim, motionAllowed, release, scramble, scrambleTick } from '../lib/obfuscate'

const props = defineProps<{
  /** The component tree, when the host sent one. Typed loosely on purpose: it is JSON the backend
   * stores without parsing, so nothing upstream has promised its shape. */
  components?: unknown
  /** The whole line in plain form. Always present, and what gets drawn when there is no tree. */
  text: string
}>()

const runs = computed(() => runsOf(props.components))

/** Read once. A reader who has asked for less motion is not going to change their mind between two
 * lines of chat, and re-reading it per frame would be a media query per frame. */
const moving = motionAllowed()

/** Whether this line has anything to scramble. Most do not, and the shared clock should not run for
 * them. */
const scrambling = computed(() => moving && runs.value.some((run) => run.obfuscated))

let claimed = false

// Joins the clock only while this line actually needs it, and lets go the moment it does not - a
// line scrolled out of the feed stops costing anything.
watch(
  scrambling,
  (needed) => {
    if (needed === claimed) return

    if (needed) claim()
    else release()

    claimed = needed
  },
  { immediate: true },
)

onUnmounted(() => {
  if (claimed) release()
})

/**
 * What to draw for a run.
 *
 * Obfuscated runs are re-scrambled every tick; everything else is its own text and never touches the
 * clock. Reading `scrambleTick` here is what subscribes this line to redraws.
 */
function shown(run: Run): string {
  if (!run.obfuscated || !moving) return run.text

  // Referenced so this recomputes on every tick. The value itself means nothing.
  void scrambleTick.value

  return scramble(run.text)
}

function styleOf(run: Run): Record<string, string> {
  return run.color ? { color: run.color } : {}
}
</script>

<template>
  <!-- No tree, or nothing renderable in it: the plain line, which is always there. -->
  <span v-if="!runs.length">{{ text }}</span>

  <span v-else>
    <span
      v-for="(run, at) in runs"
      :key="at"
      :style="styleOf(run)"
      :class="{
        'font-semibold': run.bold,
        italic: run.italic,
        underline: run.underlined,
        'line-through': run.strikethrough,
        'mc-obfuscated': run.obfuscated,
        'mc-obfuscated-still': run.obfuscated && !moving,
      }"
      >{{ shown(run) }}</span>
  </span>
</template>

<style scoped>
/**
 * Monospace while scrambling, so a run keeps its width as its characters change. In a proportional
 * face every frame would be a slightly different length and the whole line would twitch — which
 * reads as a broken feed rather than as hidden text.
 */
.mc-obfuscated {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  user-select: none;
}

/**
 * For a reader who asked for less motion: still, and just as unreadable. A blur says the same thing
 * the scrambling does without anything moving.
 */
.mc-obfuscated-still {
  font-family: inherit;
  filter: blur(0.22em);
}
</style>
