<script setup lang="ts">
import { useI18n } from 'vue-i18n'
// Aliased: `Map` is a JavaScript built-in, and shadowing it is a trap for whoever needs one here.
import { Map as MapIcon } from 'lucide-vue-next'

/**
 * Placeholder. Nothing is built behind this yet — the screen and its route exist so the shape of the
 * navigation is settled before the work that fills it starts.
 *
 * The data for a real one is already arriving: `agent.telemetry.position`, and a position on each
 * nearby player. Read-only, so it sits with the fleet screens rather than behind `fleet.control`.
 */
const { t } = useI18n()
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">{{ t('map.title') }}</h1>
      <p class="text-sm opacity-60">{{ t('map.subtitle') }}</p>
    </header>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body items-center gap-3 py-16 text-center">
        <MapIcon class="size-8 opacity-20" />
        <p class="text-sm opacity-50">{{ t('map.empty') }}</p>
      </div>
    </div>
  </div>
</template>
