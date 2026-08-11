<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { avatarUrl } from '../lib/avatars'

/**
 * A Minecraft player's head.
 *
 * The image comes from Osmium's own `/api/avatars`, never from a skin service directly: the CSP is
 * `img-src 'self' blob:`, and the point of proxying is that it stays that way. That endpoint is
 * gated on `fleet.read`, so the bytes are fetched with the token and arrive as a blob URL — see
 * `src/lib/avatars.ts`.
 *
 * **Nothing here is load-bearing.** A head is identity, not information — every place one appears,
 * the name is next to it. So an agent that has never logged in, a deployment with avatars turned
 * off and a skin service having a bad day all land on the same fallback, and the interface reads
 * exactly as it did before heads existed.
 */
const props = withDefaults(
  defineProps<{
    /** Minecraft username or UUID. Null while an agent has not been set up. */
    id?: string | null
    /** Used for the fallback initial. The visible label, not the Minecraft name. */
    name?: string | null
    size?: 'xs' | 'sm' | 'md' | 'lg'
  }>(),
  { id: null, name: null, size: 'sm' },
)

const SIZES: Record<NonNullable<typeof props.size>, string> = {
  xs: 'size-4 text-[0.5rem]',
  sm: 'size-6 text-[0.625rem]',
  md: 'size-8 text-xs',
  lg: 'size-14 text-lg',
}

/** Null until the head arrives, and again for any player who has none. Both render the fallback. */
const source = ref<string | null>(null)

watch(
  () => props.id,
  async (id) => {
    source.value = null
    if (!id) return
    const url = await avatarUrl(id)
    // The identifier can change while the fetch is in flight — a sidebar row rebound to another
    // agent — and the late answer must not overwrite the current one.
    if (props.id === id) source.value = url
  },
  { immediate: true },
)

const initial = computed(() => (props.name ?? props.id ?? '?').trim().charAt(0).toUpperCase() || '?')
</script>

<template>
  <!--
    Decorative: the name it belongs to is always beside it, so announcing the head as well would
    read the same player twice.
  -->
  <img
    v-if="source"
    :src="source"
    :class="SIZES[size]"
    class="rounded-selector shrink-0 [image-rendering:pixelated]"
    alt=""
    aria-hidden="true"
    decoding="async"
  />
  <span
    v-else
    :class="SIZES[size]"
    class="rounded-selector bg-base-300 text-base-content/50 flex shrink-0 items-center justify-center font-semibold"
    aria-hidden="true"
  >
    {{ initial }}
  </span>
</template>
