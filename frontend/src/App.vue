<script setup lang="ts">
import { useBrowserStatus } from './lib/browserStatus'

// At the root rather than in AppLayout, so the login screen is covered too: somebody who cannot sign
// in because the backend is down should be able to read that off the tab.
useBrowserStatus()
</script>

<template>
  <RouterView />
</template>
