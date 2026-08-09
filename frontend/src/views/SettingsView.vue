<script setup lang="ts">
import { Clock, Info, ServerCog, UserRound } from 'lucide-vue-next'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
</script>

<template>
  <div class="mx-auto flex max-w-4xl flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      <p class="text-sm opacity-60">Session and environment.</p>
    </header>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <UserRound class="text-primary size-4" />
          Session
        </h2>

        <ul class="list">
          <li class="list-row px-0">
            <div class="opacity-60"><UserRound class="size-5" /></div>
            <div>
              <div class="text-xs uppercase opacity-50">Signed in as</div>
              <div class="font-medium">{{ auth.user?.username ?? 'unknown' }}</div>
            </div>
          </li>
          <li class="list-row px-0">
            <div class="opacity-60"><Clock class="size-5" /></div>
            <div>
              <div class="text-xs uppercase opacity-50">Token lifetime</div>
              <div class="font-medium">1 hour, not refreshed</div>
              <div class="text-xs opacity-60">An expired session returns you to the login screen.</div>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <div class="card border-base-300 bg-base-200 border">
      <div class="card-body gap-4">
        <h2 class="card-title flex items-center gap-2 text-base">
          <ServerCog class="text-primary size-4" />
          Backend
        </h2>
        <div role="alert" class="alert alert-info alert-soft">
          <Info class="size-4" />
          <span>Nothing configurable here yet — this panel grows with the agent module.</span>
        </div>
      </div>
    </div>
  </div>
</template>
