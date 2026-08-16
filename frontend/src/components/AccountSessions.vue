<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { LogOut, Monitor, ShieldAlert, TriangleAlert } from 'lucide-vue-next'
import type { SessionResponse } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'

/**
 * Where this account is signed in, and how to end any of it.
 *
 * The point of the list is recognition, not proof. An address is only the operator's if the
 * deployment passes proxy headers through, and a browser names itself — so nothing here is stated
 * as fact about who anyone is, and the copy says as much.
 */
const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()

const sessions = ref<SessionResponse[]>([])
const loaded = ref(false)
const error = ref<string | null>(null)
const ending = ref<number | null>(null)
const revokeAllDialog = ref<HTMLDialogElement | null>(null)

onMounted(load)

async function load() {
  try {
    sessions.value = await auth.sessions()
    error.value = null
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.generic')
  } finally {
    loaded.value = true
  }
}

async function end(session: SessionResponse) {
  ending.value = session.id
  try {
    await auth.endOtherSession(session.id)
    // Ending your own leaves this browser with a revoked cookie, so it is a logout in all but name.
    if (session.current) return void router.push({ name: 'login' })
    await load()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('sessions.failed')
  } finally {
    ending.value = null
  }
}

async function endEverywhere() {
  revokeAllDialog.value?.close()
  await auth.endAllSessions()
  void router.push({ name: 'login' })
}

/** Relative where it is short, because "2 hours ago" is read faster than a timestamp. */
function when(at: string): string {
  const seconds = Math.round((new Date(at).getTime() - Date.now()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(seconds, 'second')
}

/**
 * The browser and platform out of a user-agent string, which is all anyone wants from one. Falls
 * back to the raw value rather than to nothing: an unrecognised string is still a distinguishing
 * mark, and the only job here is telling one row from another.
 */
function device(userAgent: string | null): string {
  if (!userAgent) return t('sessions.unknownDevice')
  const browser = /(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/.exec(userAgent)?.[1]
  const platform = /\((?:[^;)]*;\s*)?([^;)]+)/.exec(userAgent)?.[1]?.trim()
  const named = { Edg: 'Edge', OPR: 'Opera' }[browser ?? ''] ?? browser
  if (!named) return userAgent
  return platform ? `${named} · ${platform}` : named
}
</script>

<template>
  <div class="card border-base-300 bg-base-200 border">
    <div class="card-body gap-3">
      <h2 class="card-title flex items-center gap-2 text-base">
        <Monitor class="text-primary size-4" />
        {{ t('sessions.title') }}
        <span v-if="loaded" class="badge badge-ghost badge-sm">{{ sessions.length }}</span>
      </h2>
      <p class="text-xs opacity-50">{{ t('sessions.hint') }}</p>

      <div v-if="error" role="alert" class="alert alert-error alert-soft">
        <TriangleAlert class="size-4" />
        <span>{{ error }}</span>
      </div>

      <!-- Rows, not a spinner: the shape is known and the panel keeps its height. -->
      <div v-if="!loaded" class="flex flex-col gap-2">
        <div v-for="row in 2" :key="row" class="skeleton h-14 w-full"></div>
      </div>

      <ul v-else class="flex flex-col gap-1">
        <li
          v-for="session in sessions"
          :key="session.id"
          class="rounded-field bg-base-300/30 flex items-center gap-3 px-3 py-2"
        >
          <Monitor class="size-4 shrink-0 opacity-40" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{{ device(session.userAgent) }}</span>
              <span v-if="session.current" class="badge badge-primary badge-soft badge-xs">
                {{ t('sessions.thisDevice') }}
              </span>
            </span>
            <span class="block truncate text-xs opacity-50">
              <span class="font-mono">{{ session.clientIp ?? t('sessions.unknownAddress') }}</span>
              ·
              {{ t('sessions.startedAt', { when: when(session.startedAt) }) }}
              ·
              {{ t('sessions.endsAt', { when: when(session.expiresAt) }) }}
            </span>
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-xs gap-1"
            :disabled="ending !== null"
            @click="end(session)"
          >
            <LogOut class="size-3.5" />
            {{ ending === session.id ? t('sessions.ending') : t('sessions.end') }}
          </button>
        </li>

        <p v-if="!sessions.length" class="py-6 text-center text-sm opacity-50">
          {{ t('sessions.none') }}
        </p>
      </ul>

      <div class="border-base-300 flex flex-wrap items-center gap-3 border-t pt-4">
        <p class="min-w-0 flex-1 text-xs opacity-50">{{ t('sessions.endAllHint') }}</p>
        <button type="button" class="btn btn-error btn-soft btn-sm gap-2" @click="revokeAllDialog?.showModal()">
          <ShieldAlert class="size-4" />
          {{ t('sessions.endAll') }}
        </button>
      </div>
    </div>

    <dialog ref="revokeAllDialog" class="modal">
      <div class="modal-box">
        <h3 class="flex items-center gap-2 text-lg font-semibold">
          <ShieldAlert class="text-error size-5" />
          {{ t('sessions.endAllConfirm') }}
        </h3>
        <p class="mt-3 text-sm opacity-70">{{ t('sessions.endAllWarning') }}</p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" type="button" @click="revokeAllDialog?.close()">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-error btn-sm gap-2" type="button" @click="endEverywhere">
            <ShieldAlert class="size-4" />
            {{ t('sessions.endAll') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>
</template>
