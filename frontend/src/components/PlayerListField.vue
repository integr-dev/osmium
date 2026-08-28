<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { UserPlus, X } from 'lucide-vue-next'
import PlayerHead from './PlayerHead.vue'
import { playersFrom, playersTo, TRUST, type Trust, USERNAME } from '../lib/configuration'

/**
 * A list of Minecraft players, kept in the one string a setting can hold.
 *
 * **Heads, because a username is not how anybody recognises a player.** Half the point of a list
 * like this is checking it is the right people, and `Notch` and `N0tch` read identically in a column
 * of monospaced text while their faces do not.
 *
 * The names are validated as they are added rather than on save. Mojang allows letters, digits and
 * underscore up to sixteen, so anything else could never match a player — and an entry that silently
 * matches nobody is the failure this exists to prevent.
 */
const model = defineModel<string>({ required: true })

const { t } = useI18n()

const draft = ref('')

/** Ordered lowest first, so the options read as a scale rather than as two unrelated choices. */
const TIERS: Trust[] = [TRUST.chat, TRUST.commands]

const players = computed(() => playersFrom(model.value))

/**
 * Why the entry cannot be added, or null when it can.
 *
 * Only once something has been typed: an empty box is not a mistake, it is a box nobody has used
 * yet, and colouring it red on sight is the interface telling somebody off for arriving.
 */
const refusal = computed(() => {
  const name = draft.value.trim()
  if (!name) return null
  if (!USERNAME.test(name)) return t('configuration.players.notAName')
  if (players.value.some((other) => other.name.toLowerCase() === name.toLowerCase())) {
    return t('configuration.players.alreadyThere')
  }

  return null
})

const addable = computed(() => draft.value.trim().length > 0 && refusal.value === null)

function add(): void {
  if (!addable.value) return

  // Appended rather than sorted, and at the lower tier. The order is the operator's, and a list that
  // rearranges itself under the hand editing it is one nobody can keep their place in; the tier is
  // the safe one because granting the other has to be something somebody chose, not something that
  // happened by typing a name.
  model.value = playersTo([...players.value, { name: draft.value.trim(), trust: TRUST.chat }])
  draft.value = ''
}

function remove(name: string): void {
  model.value = playersTo(players.value.filter((other) => other.name !== name))
}

function trust(name: string, to: Trust): void {
  model.value = playersTo(players.value.map((other) => (other.name === name ? { ...other, trust: to } : other)))
}

/**
 * Pasting a list works, because that is what anybody with a list already written down will try.
 *
 * Anything unusable in what was pasted is dropped by `playersFrom` rather than refused whole: a
 * pasted column tends to carry a stray heading or a blank line, and losing the ninety names that
 * were fine to save the one that was not is a worse trade.
 */
function paste(event: ClipboardEvent): void {
  const dropped = event.clipboardData?.getData('text') ?? ''
  if (!/[\s,]/.test(dropped)) return

  event.preventDefault()
  model.value = playersTo([...players.value, ...playersFrom(dropped)])
  draft.value = ''
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <!--
      First, directly under the field's own explanation, because it qualifies the whole control
      rather than any one part of it. Stated plainly and specifically: a vague warning about
      "security" teaches nothing, and the situations named here are the ones where the guarantee
      genuinely is not there.
    -->
    <p class="text-error text-xs">{{ t('configuration.players.disclaimer') }}</p>

    <form class="flex gap-2" @submit.prevent="add">
      <input
        v-model="draft"
        class="input input-sm w-full font-mono"
        type="text"
        maxlength="16"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('configuration.players.add')"
        :aria-invalid="refusal !== null"
        @paste="paste"
      />
      <button
        class="btn btn-sm btn-square"
        type="submit"
        :aria-label="t('configuration.players.add')"
        :disabled="!addable"
      >
        <UserPlus class="size-4" />
      </button>
    </form>

    <p v-if="refusal" class="text-warning text-xs">{{ refusal }}</p>

    <!--
      One player a row, in a box with a bounded height. A whitelist is read down and counted, and a
      long one must not push the rest of the form off the page — so it scrolls inside itself once it
      is taller than a screenful is worth.
    -->
    <div class="border-base-300 bg-base-100/40 overflow-hidden rounded-box border">
      <ul v-if="players.length" class="divide-base-300 max-h-64 divide-y overflow-y-auto">
        <li
          v-for="player in players"
          :key="player.name"
          class="flex items-center gap-2.5 py-1.5 pr-1.5 pl-2.5"
        >
          <PlayerHead :id="player.name" :name="player.name" size="sm" class="shrink-0" />
          <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ player.name }}</span>

          <!--
            A select rather than a pair of buttons. Two buttons meant one was always drawn dimmed
            beside a live one, which read as disabled rather than as unselected — and a row scanned
            down a list has to answer "what is this set to" at a glance, which is a value rather
            than a choice between two.

            Coloured only at the elevated tier, so what stands out in the column is the entry worth
            looking at twice.
          -->
          <select
            :value="player.trust"
            class="select select-xs w-36 shrink-0"
            :class="player.trust === TRUST.commands ? 'select-warning text-warning' : ''"
            :aria-label="t('configuration.players.trust')"
            @change="trust(player.name, ($event.target as HTMLSelectElement).value as Trust)"
          >
            <option v-for="tier in TIERS" :key="tier" :value="tier">
              {{ t(`configuration.players.${tier}`) }}
            </option>
          </select>

          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square opacity-50 hover:opacity-100"
            :aria-label="t('configuration.players.remove', { name: player.name })"
            @click="remove(player.name)"
          >
            <X class="size-3.5" />
          </button>
        </li>
      </ul>

      <p v-else class="px-2.5 py-3 text-xs opacity-50">{{ t('configuration.players.empty') }}</p>
    </div>

    <!-- Counted, because "is everybody on here" is the question a list like this is opened to answer. -->
    <p v-if="players.length" class="text-xs opacity-50">
      {{ t('configuration.players.count', { count: players.length }, players.length) }}
    </p>
  </div>
</template>
