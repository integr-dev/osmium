<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Boxes,
  CircleAlert,
  Database,
  HardDrive,
  Hammer,
  Map as MapIcon,
  MapPin,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Shapes,
  Trash2,
  TriangleAlert,
  Users,
  Waypoints,
} from 'lucide-vue-next'
import {
  api,
  errorMessage,
  type StorageArea,
  type StorageAreaResponse,
  type StorageResponse,
} from '../api/client'
import { useAuthStore } from '../stores/auth'
import { bytes } from '../lib/bytes'
import { atShort } from '../lib/time'
import { t } from '../i18n'

/**
 * What the deployment is holding on disk, and the two ways of holding less.
 *
 * **Deleting and reclaiming are two actions, and the screen is built around saying so.** Deleting a
 * month of chat leaves the space exactly where it was — the table keeps it and will reuse it — and
 * the disk does not shrink until something rewrites the table. An operator who deletes and watches
 * the number not move concludes the button is broken, so the space a delete leaves behind is a
 * column of its own, and returning it is a button of its own that says what it costs.
 */
const auth = useAuthStore()

const report = ref<StorageResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/** Which area's purge dialog is open, or null. */
const purging = ref<StorageArea | null>(null)

/** How much to keep, in days. Zero here means the whole area, which the dialog spells out. */
const keepDays = ref(30)
const working = ref(false)

const reclaimDialog = ref<HTMLDialogElement | null>(null)

/** An icon per area, so the list is scannable as a list of *things* rather than of words. */
const ICONS: Record<StorageArea, typeof Database> = {
  CHAT: MessageSquare,
  ACTIVITY: Waypoints,
  MAP: MapIcon,
  POSITIONS: MapPin,
  AUDIT: ScrollText,
  SCHEMATICS: Shapes,
  BUILDS: Hammer,
  FLEET: Boxes,
  ACCOUNTS: Users,
  OTHER: Database,
}

/** What the areas add up to, which is less than the database and is worth being able to see. */
const accounted = computed(() => (report.value?.areas ?? []).reduce((sum, a) => sum + a.totalBytes, 0))

/**
 * What share of everything stored an area is.
 *
 * The bars were scaled against the largest area, which meant the biggest one was always full and
 * every other one was a fraction of *it* — a reading with no meaning outside the list, and one the
 * byte figure beside it already gave. A share of the total is the thing the numbers do not say:
 * that chat is most of what this deployment keeps, or that it is a rounding error next to the
 * schematics.
 *
 * Shown as a number as well as a bar. A bar with nothing written on it is a decoration.
 */
function share(area: StorageAreaResponse): number {
  return accounted.value === 0 ? 0 : (area.totalBytes / accounted.value) * 100
}

/** Space that deleting has already freed and that only a rewrite will hand back. */
const reclaimable = computed(() => (report.value?.areas ?? []).reduce((sum, a) => sum + a.deadBytes, 0))

/**
 * Why an area has no delete button, in the terms that are true of *this* area right now.
 *
 * The trail is the record of this screen being used and is never purgeable. The rest are owned by
 * pages that understand what hangs off their rows — except when they are already empty, where the
 * honest answer is that nothing is stored and the disk is simply not back yet.
 */
function why(area: StorageAreaResponse): string {
  if (area.area === 'AUDIT') return t('storage.keptAudit')
  if (area.rows === 0 && area.deadBytes > 0) return t('storage.emptied')
  return t('storage.keptElsewhere')
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const { data, error: failure } = await api.GET('/api/storage')
    if (failure) throw new Error(errorMessage(failure, t('errors.loadStorage')))
    report.value = data as StorageResponse
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.loadStorage')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openPurge(area: StorageArea): void {
  purging.value = area
  keepDays.value = 30
}

/** The area currently being purged, as it stands in the report. */
const target = computed(() => report.value?.areas.find((a) => a.area === purging.value) ?? null)

async function confirmPurge(): Promise<void> {
  const area = purging.value
  if (!area || working.value) return

  working.value = true
  error.value = null
  try {
    const { error: failure } = await api.POST('/api/storage/{area}/purge', {
      params: { path: { area } },
      // Zero means everything. Sent as an absent field rather than as a zero, because the API takes
      // "keep this many days" and there is no such thing as keeping zero of them.
      body: keepDays.value > 0 ? { keepDays: keepDays.value } : {},
    })
    if (failure) throw new Error(errorMessage(failure, t('errors.purgeStorage')))
    purging.value = null
    await load()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.purgeStorage')
  } finally {
    working.value = false
  }
}

async function confirmReclaim(): Promise<void> {
  if (working.value) return

  working.value = true
  error.value = null
  try {
    const { error: failure } = await api.POST('/api/storage/reclaim')
    if (failure) throw new Error(errorMessage(failure, t('errors.reclaimStorage')))
    reclaimDialog.value?.close()
    await load()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.reclaimStorage')
  } finally {
    working.value = false
  }
}
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
    <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">{{ t('storage.title') }}</h1>
          <p class="text-sm opacity-60">{{ t('storage.subtitle') }}</p>
        </div>
        <button class="btn btn-ghost btn-sm gap-2" :disabled="loading" @click="load">
          <RefreshCw class="size-4" :class="loading ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </button>
      </header>

      <div class="stats border-base-300 bg-base-200 w-full border">
        <div class="stat">
          <div class="stat-figure text-primary"><HardDrive class="size-7" /></div>
          <div class="stat-title">{{ t('storage.database') }}</div>
          <div class="stat-value text-3xl tabular-nums">{{ bytes(report?.databaseBytes ?? 0) }}</div>
          <div class="stat-desc">{{ t('storage.accounted', { size: bytes(accounted) }) }}</div>
        </div>
        <div class="stat">
          <div class="stat-figure opacity-60"><Trash2 class="size-7" /></div>
          <div class="stat-title">{{ t('storage.reclaimable') }}</div>
          <div class="stat-value text-3xl tabular-nums">{{ bytes(reclaimable) }}</div>
          <!-- Said every time it is shown: it is a ratio off the statistics, not a measurement. -->
          <div class="stat-desc">{{ t('storage.reclaimableNote') }}</div>
        </div>
      </div>

      <div v-if="error" role="alert" class="alert alert-error alert-soft">
        <CircleAlert class="size-4 shrink-0" />
        <span>{{ error }}</span>
      </div>

      <div class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <Database class="text-primary size-4" />
            {{ t('storage.byArea') }}
          </h2>
          <!-- What the bar is a share of, since a bar on its own is an unlabelled axis. -->
          <p class="-mt-1 text-xs opacity-50">{{ t('storage.shareNote') }}</p>

          <div v-if="loading && !report" class="flex flex-col gap-2">
            <div v-for="row in 6" :key="row" class="skeleton h-14 w-full"></div>
          </div>

          <ul v-else class="flex flex-col gap-1">
            <!--
              A grid, not a flex row. Laid out with flex the columns started wherever the name
              before them happened to end, so no two rows lined up and the sizes could not be read
              down the page - which is the only way anybody reads a list of sizes.
            -->
            <li
              v-for="area in report?.areas ?? []"
              :key="area.area"
              class="rounded-field bg-base-300/30 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_9rem_5rem_6rem_8rem]"
            >
              <component :is="ICONS[area.area]" class="text-primary size-4 shrink-0 opacity-70" />

              <span class="min-w-0">
                <span class="block text-sm font-medium">{{ t(`storage.areas.${area.area}`) }}</span>
                <span class="block text-xs opacity-50">
                  {{ t('storage.rows', { n: area.rows.toLocaleString() }) }}
                  <template v-if="area.oldest">
                    <span class="opacity-60"> · </span>{{ t('storage.since', { when: atShort(area.oldest) }) }}
                  </template>
                </span>
              </span>

              <!-- What share of everything stored this is, with the number the bar stands for. -->
              <span class="hidden items-center gap-2 sm:flex">
                <span class="bg-base-300 h-2 flex-1 overflow-hidden rounded-full">
                  <span class="bg-primary block h-full rounded-full" :style="{ width: `${share(area)}%` }"></span>
                </span>
                <span class="w-9 text-right text-xs tabular-nums opacity-50">
                  {{ share(area) < 1 && area.totalBytes > 0 ? '<1%' : `${Math.round(share(area))}%` }}
                </span>
              </span>

              <span class="text-right text-sm tabular-nums max-sm:col-start-3">{{ bytes(area.totalBytes) }}</span>

              <span class="hidden text-right text-xs tabular-nums opacity-50 sm:block">
                <template v-if="area.deadBytes > 0">{{ t('storage.dead', { size: bytes(area.deadBytes) }) }}</template>
              </span>

              <button
                v-if="area.purgeable && auth.can('storage.purge')"
                class="btn btn-soft btn-error btn-xs col-span-full gap-1.5 justify-self-end sm:col-span-1"
                @click="openPurge(area.area)"
              >
                <Trash2 class="size-3" />
                {{ t('storage.purge') }}
              </button>
              <!--
                Why the ones without a button have none — and, for one of them, that there is
                nothing to go and do.

                An area holding no rows and a hundred megabytes has already been emptied: sending
                somebody to the page that manages it is sending them somewhere with nothing on it,
                when the space is waiting on the reclaim button below. That case reads differently
                from an area that genuinely has records somewhere else.
              -->
              <span v-else class="col-span-full text-right text-xs opacity-40 sm:col-span-1">
                {{ why(area) }}
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="auth.can('storage.purge')" class="card border-base-300 bg-base-200 border">
        <div class="card-body gap-3">
          <h2 class="card-title flex items-center gap-2 text-base">
            <RefreshCw class="text-primary size-4" />
            {{ t('storage.reclaimTitle') }}
          </h2>
          <p class="text-sm opacity-70">{{ t('storage.reclaimBody') }}</p>
          <div class="flex justify-end">
            <button class="btn btn-warning btn-sm gap-2" :disabled="working" @click="reclaimDialog?.showModal()">
              <RefreshCw class="size-4" />
              {{ t('storage.reclaimAction') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!--
      A dialog rather than an inline control, for the reason every other destructive action here
      gets one: the row it is about stays visible behind it, and the sentence naming what goes has
      to be read before the button under it can be pressed.
    -->
    <dialog class="modal" :open="purging !== null" @close="purging = null">
      <div v-if="target" class="modal-box">
        <h3 class="text-lg font-semibold">
          {{ t('storage.purgeTitle', { area: t(`storage.areas.${target.area}`) }) }}
        </h3>

        <label class="fieldset mt-4">
          <span class="fieldset-legend">{{ t('storage.keep') }}</span>
          <input v-model.number="keepDays" type="number" min="0" class="input w-full" />
          <span class="label">{{ t('storage.keepHint') }}</span>
        </label>

        <div v-if="keepDays > 0" role="status" class="alert alert-info alert-soft mt-4 text-sm">
          <TriangleAlert class="size-4 shrink-0" />
          <span>{{ t('storage.purgeOlder', { days: keepDays }) }}</span>
        </div>
        <div v-else role="alert" class="alert alert-error alert-soft mt-4 text-sm">
          <TriangleAlert class="size-4 shrink-0" />
          <span>{{ t('storage.purgeAll', { area: t(`storage.areas.${target.area}`) }) }}</span>
        </div>

        <!-- The part that surprises people, said before they press it rather than after. -->
        <p class="mt-3 text-xs opacity-60">{{ t('storage.purgeNote') }}</p>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" :disabled="working" @click="purging = null">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-error btn-sm" :disabled="working" @click="confirmPurge">
            {{ working ? t('storage.purging') : t('storage.purge') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>

    <dialog ref="reclaimDialog" class="modal">
      <div class="modal-box">
        <h3 class="text-lg font-semibold">{{ t('storage.reclaimTitle') }}</h3>
        <p class="mt-2 text-sm opacity-70">{{ t('storage.reclaimConfirm', { size: bytes(reclaimable) }) }}</p>

        <div role="alert" class="alert alert-warning alert-soft mt-4 text-sm">
          <TriangleAlert class="size-4 shrink-0" />
          <span>{{ t('storage.reclaimLock') }}</span>
        </div>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" :disabled="working" @click="reclaimDialog?.close()">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-warning btn-sm" :disabled="working" @click="confirmReclaim">
            {{ working ? t('storage.reclaiming') : t('storage.reclaimAction') }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop"><button>{{ t('common.close') }}</button></form>
    </dialog>
  </div>
</template>
