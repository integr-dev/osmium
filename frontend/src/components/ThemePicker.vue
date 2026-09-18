<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Check, Palette } from 'lucide-vue-next'
import ThemeSwatch from './ThemeSwatch.vue'
import { setTheme, THEME_CHOICES, themeChoice, themeName, type ThemeChoice } from '../lib/theme'

const { t } = useI18n()

/** Blurred after a pick, for the reason `LanguagePicker` gives: the menu is held open by focus. */
function choose(choice: ThemeChoice) {
  setTheme(choice)
  ;(document.activeElement as HTMLElement | null)?.blur()
}
</script>

<template>
  <!-- The language picker's shape exactly, so the two read as one pair of settings. -->
  <li class="dropdown dropdown-top w-full">
    <div tabindex="0" role="button" class="gap-3">
      <Palette class="size-4 shrink-0" />
      {{ t('theme.label') }}
      <span class="ml-auto text-xs opacity-60">{{ t(themeName(themeChoice)) }}</span>
    </div>

    <ul
      tabindex="0"
      class="dropdown-content menu rounded-box border-base-300 bg-base-100 z-10 mb-1 ms-0 max-h-[70vh] w-60 flex-nowrap overflow-y-auto border p-1 ps-1 shadow-lg before:hidden"
    >
      <li v-for="choice in THEME_CHOICES" :key="choice">
        <button type="button" class="gap-3" :aria-pressed="themeChoice === choice" @click="choose(choice)">
          <ThemeSwatch :choice="choice" />
          {{ t(themeName(choice)) }}
          <Check v-if="themeChoice === choice" class="text-primary ml-auto size-4" />
        </button>
      </li>
    </ul>
  </li>
</template>
