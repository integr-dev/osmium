<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Check, Globe } from 'lucide-vue-next'
import { LOCALES, setLocale, type Locale } from '../i18n'

const { t, locale } = useI18n()

const codes = Object.keys(LOCALES) as Locale[]

/**
 * The dropdown is held open by `:focus-within`, so clicking an entry inside it would keep it open —
 * the click moves focus to the button rather than away from the menu. Blurring closes it.
 */
function choose(code: Locale) {
  setLocale(code)
  ;(document.activeElement as HTMLElement | null)?.blur()
}
</script>

<template>
  <!--
    An `li` of the surrounding `menu`, not a lookalike: the trigger is a bare child of the `li`, so
    daisyUI gives it the same padding, height and hover treatment as the links beside it. Hand-set
    padding drifts the moment the theme changes.

    Opens upward — it sits at the bottom of the sidebar, where a downward menu would be cut off.
  -->
  <li class="dropdown dropdown-top w-full">
    <div tabindex="0" role="button" class="gap-3">
      <Globe class="size-4 shrink-0" />
      {{ t('language.label') }}
      <span class="ml-auto text-xs opacity-60">{{ t(`language.${locale}`) }}</span>
    </div>

    <!--
      `menu` nests lists as sub-menus, indenting them and drawing a rule down the side. This one is
      an overlay rather than a branch, so that treatment is undone.
    -->
    <ul
      tabindex="0"
      class="dropdown-content menu rounded-box border-base-300 bg-base-100 z-10 mb-1 ms-0 w-52 border p-1 ps-1 shadow-lg before:hidden"
    >
      <li v-for="code in codes" :key="code">
        <button type="button" class="gap-3" @click="choose(code)">
          {{ t(`language.${code}`) }}
          <Check v-if="locale === code" class="text-primary ml-auto size-4" />
        </button>
      </li>
    </ul>
  </li>
</template>
