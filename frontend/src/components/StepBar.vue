<script lang="ts">
/** One step. The label never carries its own number — the marker on the line is where it lives. */
export type Step<T extends string = string> = {
  id: T
  label: string
}
</script>

<script setup lang="ts" generic="T extends string">
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'

/**
 * A line with the steps on it, rather than daisyUI's `steps`.
 *
 * daisyUI lays a step out as a column with the label centred under its marker, which leaves the label
 * hanging in the middle of its share of the row and the row itself only as wide as its widest
 * label. Four short words across a full-width panel therefore sat in a huddle with space either
 * side of them, which is the wonkiness this replaces.
 *
 * Here the row is one line the full width of whatever holds it, the steps are equal shares of it,
 * and each label is left-aligned above its own marker — so the eye reads left to right along a
 * single rule instead of hopping between centred columns.
 *
 * **The line is the progress bar.** It is drawn twice: once whole and quiet, once coloured and cut
 * to the step you are on. Nothing else needs to say how far in you are.
 */
const props = defineProps<{
  steps: Step<T>[]
  current: T
  /** Whether a step can be jumped to. The parent decides what is reachable; this only asks. */
  clickable?: boolean
}>()

const emit = defineEmits<{ select: [T] }>()

const at = computed(() => Math.max(0, props.steps.findIndex((step) => step.id === props.current)))

/** Each step owns an equal share of the width, and its marker sits at the start of that share. */
const share = computed(() => 100 / Math.max(1, props.steps.length))

/**
 * How far the coloured line runs: to the middle of the marker you are standing on.
 *
 * In percent plus half a marker, because the markers are placed in percent and drawn in rem —
 * mixing the two is what `calc` is for, and hard-coding either would break at the other end of the
 * range of widths this sits in. Half of `size-5`, so it moves with the marker if that changes.
 */
const filled = computed(() => `calc(${at.value * share.value}% + 0.625rem)`)

function offset(index: number): string {
  return `${index * share.value}%`
}

function pick(step: Step<T>) {
  if (props.clickable) emit('select', step.id)
}
</script>

<template>
  <div class="flex w-full flex-col gap-1">
    <!--
      Above the line and left-aligned over their own markers, which is the whole difference from a
      set of centred columns: the labels start where the markers do, so the row reads as one line
      with things written along it.
    -->
    <div class="flex w-full">
      <span
        v-for="(step, index) in steps"
        :key="step.id"
        class="osmium-step-label min-w-0 truncate pr-2 text-xs"
        :class="[
          index < at ? 'text-primary' : index === at ? 'font-semibold' : 'opacity-60',
          index === steps.length - 1 ? 'pr-0' : '',
        ]"
        :style="{ width: `${share}%` }"
      >
        {{ step.label }}
      </span>
    </div>

    <div class="relative h-5">
      <!-- The whole line, then the part of it that has been walked. -->
      <span
        aria-hidden="true"
        class="bg-base-content/20 absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2"
      ></span>
      <span
        aria-hidden="true"
        class="bg-primary osmium-step-fill absolute top-1/2 left-0 h-0.5 -translate-y-1/2"
        :style="{ width: filled }"
      ></span>

      <component
        :is="clickable ? 'button' : 'span'"
        v-for="(step, index) in steps"
        :key="step.id"
        :type="clickable ? 'button' : undefined"
        :title="step.label"
        :aria-current="index === at ? 'step' : undefined"
        class="osmium-step-dot rounded-field absolute top-1/2 flex size-5 -translate-y-1/2 items-center justify-center text-[0.625rem] font-semibold tabular-nums"
        :class="[
          index < at
            ? 'bg-primary text-primary-content'
            : index === at
              ? 'bg-base-content text-base-100'
              : 'bg-base-300 text-base-content/60',
          clickable ? 'cursor-pointer' : '',
        ]"
        :style="{ left: offset(index) }"
        @click="pick(step)"
      >
        <!-- A check for what is behind you, the number for everything else. -->
        <Check v-if="index < at" class="size-2.5" />
        <template v-else>{{ index + 1 }}</template>
      </component>
    </div>
  </div>
</template>
