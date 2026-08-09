<script setup lang="ts">
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { Bot, LayoutDashboard, LogOut, Menu, Settings, User, Users } from 'lucide-vue-next'
import { useAuthStore } from '../stores/auth'
import { useBotStore } from '../stores/bots'

const auth = useAuthStore()
const botStore = useBotStore()
const router = useRouter()

function logout() {
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <div class="drawer lg:drawer-open">
    <input id="app-drawer" type="checkbox" class="drawer-toggle" />

    <div class="drawer-content flex min-h-screen flex-col">
      <!-- Only reachable below lg, where the sidebar is collapsed. -->
      <div class="navbar border-base-300 bg-base-200 border-b lg:hidden">
        <label for="app-drawer" class="btn btn-square btn-ghost btn-sm" aria-label="Open navigation">
          <Menu class="size-5" />
        </label>
        <img src="/logo.svg" alt="" class="ml-2 size-6" />
        <span class="ml-2 font-semibold">Osmium</span>
      </div>

      <main class="flex-1 px-6 py-8">
        <RouterView />
      </main>
    </div>

    <div class="drawer-side">
      <label for="app-drawer" class="drawer-overlay" aria-label="Close navigation"></label>

      <aside class="border-base-300 bg-base-200 flex min-h-full w-64 flex-col border-r">
        <div class="flex items-center gap-3 px-5 py-6">
          <img src="/logo.svg" alt="" class="size-8" />
          <span class="text-lg font-semibold tracking-tight">Osmium</span>
        </div>

        <div class="flex-1 overflow-y-auto px-3">
          <ul class="menu w-full gap-0.5 p-0">
            <li>
              <RouterLink :to="{ name: 'dashboard' }" class="gap-3">
                <LayoutDashboard class="size-4 shrink-0" />
                Dashboard
              </RouterLink>
            </li>
            <li>
              <details open>
                <summary class="gap-3">
                  <Bot class="size-4 shrink-0" />
                  Bots
                  <span class="badge badge-xs ml-auto">{{ botStore.online.length }}/{{ botStore.bots.length }}</span>
                </summary>
                <ul class="gap-0.5">
                  <li v-for="bot in botStore.bots" :key="bot.id">
                    <RouterLink :to="{ name: 'bot', params: { id: bot.id } }" class="gap-2.5">
                      <span
                        class="size-2 shrink-0 rounded-full"
                        :class="bot.online ? 'bg-success' : 'bg-error'"
                        :title="bot.online ? 'Online' : 'Offline'"
                      ></span>
                      <span class="truncate">{{ bot.name }}</span>
                    </RouterLink>
                  </li>
                </ul>
              </details>
            </li>
          </ul>
        </div>

        <div class="border-base-300 border-t p-3">
          <ul class="menu w-full gap-0.5 p-0">
            <li>
              <RouterLink :to="{ name: 'account' }" class="gap-3">
                <User class="size-4 shrink-0" />
                My account
              </RouterLink>
            </li>
            <li v-if="auth.can('user.read')">
              <RouterLink :to="{ name: 'accounts' }" class="gap-3">
                <Users class="size-4 shrink-0" />
                All accounts
              </RouterLink>
            </li>
            <li>
              <RouterLink :to="{ name: 'settings' }" class="gap-3">
                <Settings class="size-4 shrink-0" />
                Settings
              </RouterLink>
            </li>
            <li>
              <button type="button" class="text-error hover:bg-error/10 gap-3" @click="logout">
                <LogOut class="size-4 shrink-0" />
                Log out
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </div>
</template>
