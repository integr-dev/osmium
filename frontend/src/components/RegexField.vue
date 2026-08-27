<script setup lang="ts">
/**
 * A regular expression, coloured as it is typed.
 *
 * **A real input with a coloured layer behind it.** The caret, selection, undo and every keyboard
 * convention stay the browser's — a `contenteditable` would have to reimplement all of it and would
 * get subtly wrong. The input's own glyphs are transparent; what you read is the layer beneath,
 * drawn from the same string.
 *
 * That only works while the two boxes agree **to the pixel**, and the arrangement here is what makes
 * that structural rather than a coincidence to be maintained:
 *
 * - the framework's own `input` class stays on the **wrapper**, so the field keeps its border,
 *   height, focus ring and disabled state without any of it being reimplemented here;
 * - inside it sits a stack with **no padding of its own**, and the layer and the input both fill
 *   that stack exactly, sharing one declaration for font, size and line height.
 *
 * The first version of this styled both elements with `input` directly. That class produces a
 * different box on a `<pre>` than on an `<input>`, so the caret and selection drifted by whatever
 * the difference came to.
 *
 * `tokenize` is total and loses nothing, so the layer is always exactly the input's text.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { captureFrom, faultIn, tokenize } from '../lib/regexHighlight'

const props = defineProps<{
  /** Optional so a field can exist before its value does — binding into a map that has no entry
   * yet is ordinary, and a required prop turns that into a warning and a broken render. */
  modelValue?: string
  /** Filled in by the button, when the operator asks for a starting point. */
  default?: string
  /** A line to try the pattern against, so it can be seen working. */
  sample?: string
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const { t } = useI18n()

const input = ref<HTMLInputElement | null>(null)
const layer = ref<HTMLElement | null>(null)

const value = computed(() => props.modelValue ?? '')

const tokens = computed(() => tokenize(value.value))
const fault = computed(() => faultIn(value.value))

/** What the pattern reads out of the sample, when there is one and it works. */
const capture = computed(() =>
  props.sample && value.value ? captureFrom(value.value, props.sample) : undefined,
)

/** Colour per kind. Structure is what an operator is looking for — where the capture group is —
 * so groups are the one thing given the accent; the rest recede. */
const COLOURS: Record<string, string> = {
  group: 'text-primary font-semibold',
  class: 'text-secondary',
  escape: 'text-accent',
  quantifier: 'text-warning',
  anchor: 'text-info',
  literal: '',
}

/** Only the input scrolls; the layer is moved to match. Without this a pattern longer than the box
 * slides out from under the caret. */
function sync(): void {
  if (layer.value && input.value) layer.value.scrollLeft = input.value.scrollLeft
}

// After the layer has been redrawn, or it is scrolled to a width it does not have yet.
watch(value, () => void nextTick(sync))

function fill(): void {
  if (props.default) emit('update:modelValue', props.default)
  void nextTick(() => input.value?.focus())
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <!-- The framework's field, unmodified: border, height, focus ring, disabled and error states. -->
    <label class="input input-sm w-full" :class="fault === 'invalid' ? 'input-error' : ''">
      <span class="regex-stack">
        <!--
          First in the stack, so it paints *under* the coloured layer. That order is what keeps the
          selection native: the browser draws its own band inside this element, and the glyphs above
          it stay readable — no `::selection` override, so the colour is whatever every other field
          on the page uses.
        -->
        <input
          ref="input"
          :value="value"
          type="text"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          class="regex-text regex-input"
          :placeholder="placeholder"
          :disabled="disabled"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          @scroll="sync"
        />

        <!--
          Over the input and never interactive. `aria-hidden` because the input already carries the
          value for anything reading the page — this is the same text, in colour.
        -->
        <pre ref="layer" aria-hidden="true" class="regex-text regex-layer"><span
          v-for="(token, at) in tokens"
          :key="at"
          :class="COLOURS[token.kind]"
        >{{ token.text }}</span></pre>
      </span>
    </label>

    <!--
      What is wrong, or what it does. A pattern with no capture group is the one worth saying out
      loud: it compiles and matches and can still name nobody, which from outside looks like the
      setting being ignored.
    -->
    <p v-if="fault === 'invalid'" class="text-error text-xs">{{ t('configuration.regex.invalid') }}</p>
    <p v-else-if="fault === 'nocapture'" class="text-warning text-xs">
      {{ t('configuration.regex.noCapture') }}
    </p>
    <p v-else-if="sample && value" class="text-xs" :class="capture ? 'opacity-60' : 'text-warning'">
      <template v-if="capture">
        {{ t('configuration.regex.reads', { sample, name: capture }) }}
      </template>
      <template v-else>{{ t('configuration.regex.noMatch', { sample }) }}</template>
    </p>

    <button
      v-if="props.default && value !== props.default"
      type="button"
      class="btn btn-ghost btn-xs self-start"
      :disabled="disabled"
      @click="fill"
    >
      {{ t('configuration.regex.useDefault') }}
    </button>
  </div>
</template>

<style scoped>
/**
 * The content area of the field, and the only thing positioned. It carries no padding, so the two
 * layers inside it start at the same origin — the wrapper's own padding is what insets them both.
 *
 * The monospace face is set once here and inherited, rather than declared on each layer where the
 * two could be changed apart.
 */
.regex-stack {
  position: relative;
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  height: 1.5rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/**
 * Everything that decides where a glyph lands. Both layers take this and nothing else that affects
 * metrics; the fixed line height equal to the stack height is what makes the input's vertically
 * centred text sit exactly on the layer's top-aligned text.
 */
.regex-text {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  font: inherit;
  font-size: 0.8125rem;
  line-height: 1.5rem;
  letter-spacing: normal;
  tab-size: 4;
  /* One line that scrolls, never wraps: folding a pattern moves where its parts appear to be. */
  white-space: pre;
}

.regex-layer {
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}

.regex-input {
  overflow-x: auto;
  background: transparent;
  /* The glyphs come from the layer; only the caret is drawn from the input. */
  color: transparent;
  caret-color: var(--color-base-content, currentColor);
  outline: none;
}

/**
 * Nothing here overrides `::selection`, deliberately.
 *
 * The band is painted by the input, which sits *under* the coloured layer, so the browser's own
 * selection shows through with the glyphs still on top of it. Earlier versions layered the input on
 * top and had to invent a translucent band to see through — which is why the selection was a
 * different colour from every other field on the page. Getting the order right removed the need for
 * a colour at all.
 */
.regex-input::placeholder {
  color: var(--color-base-content, currentColor);
  opacity: 0.4;
}
</style>
