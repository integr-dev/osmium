<script setup lang="ts">
import type { Component } from 'vue'

/**
 * A daisyUI text field with a leading icon *and* floating-label behaviour.
 *
 * These normally look mutually exclusive: the icon pattern wraps the input in an `.input`
 * container, while `floating-label` is documented with a bare input as its child. It composes
 * anyway, because the float is driven by `:focus-within` and `:not(:has(input:placeholder-shown))`,
 * both of which match at any depth. The label needs no offset for the icon: floated, it sits on the
 * field's top border, above the icon; unfloated, it is transparent. The field does need to sit on a
 * base-100 surface, since daisyUI hardcodes that as the label chip's background.
 *
 * A placeholder is mandatory for the effect - `:placeholder-shown` is what detects an empty field -
 * so it falls back to the label.
 */
defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{
    label: string
    icon?: Component
    placeholder?: string
    invalid?: boolean
  }>(),
  { invalid: false },
)

const model = defineModel<string>({ required: true })
</script>

<template>
  <!--
    The wrapper is a div and the field container is the label, not the other way round: daisyUI
    styles `.floating-label > span` as the absolutely positioned, initially transparent chip, so a
    <span> field container would itself be hidden until focus.
  -->
  <div class="floating-label">
    <span>{{ label }}</span>
    <label class="input w-full" :class="invalid ? 'input-error' : ''">
      <component :is="icon" v-if="icon" class="size-4 shrink-0 opacity-60" />
      <input v-model="model" :placeholder="placeholder ?? label" v-bind="$attrs" />
    </label>
  </div>
</template>
