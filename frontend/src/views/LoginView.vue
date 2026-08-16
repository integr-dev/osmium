<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { safeRedirect } from '../router'
import { CircleAlert, KeyRound, LogIn, TriangleAlert, UserRound } from 'lucide-vue-next'
import { backendReachable } from '../api/client'
import FormField from '../components/FormField.vue'
import SchematicBackdrop from '../components/SchematicBackdrop.vue'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const usernameField = ref<InstanceType<typeof FormField>>()

onMounted(() => usernameField.value?.focus())

/**
 * Caps Lock, which the browser will only say during a keystroke — there is no way to ask it on
 * focus. So the warning appears one character in rather than before the first, which is early
 * enough: the alternative is finding out from a rejected password.
 */
const capsLock = ref(false)

function trackCapsLock(event: KeyboardEvent) {
  capsLock.value = event.getModifierState('CapsLock')
}

async function submit() {
  busy.value = true
  error.value = null
  try {
    await auth.login(username.value, password.value)
    // Anyone can put anything in ?redirect=, so it is only followed when it names a path in this
    // app. See safeRedirect.
    await router.push(safeRedirect(route.query.redirect) ?? { name: 'dashboard' })
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('errors.loginFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
    <SchematicBackdrop />

    <div class="relative w-full max-w-sm">
      <!--
        daisyUI's aura: a conic sweep in `currentColor` around the card, plus two blurred copies of
        itself behind. `aura-dual` puts two lobes on the ring instead of one, so a turn reads as a
        rotation rather than as a single light going round.

        `currentColor` is how the sweep is coloured, so the brand colour has to be set here as
        text colour — and it inherits, which turned every word in the card green. The card sets it
        back.
      -->
      <div class="aura aura-dual aura-lg text-primary w-full duration-[8s]">
        <!--
          Translucent over the backdrop rather than sitting on it as a solid, so the disc carries
          through the page instead of stopping at the card's edge. `backdrop-blur` is what keeps
          the form readable over moving blocks.

          Only slightly, though, and that is the aura's doing rather than a taste call. Its glow is
          two blurred copies of the ring sitting *behind* this element, so a see-through card
          publishes them across its whole face instead of letting them read as a rim — which is the
          washed corner you get at anything much under this. The floating labels agree: daisyUI
          hardcodes their chips to `base-100`, and the further this drifts from opaque the more
          they read as patches. See FormField.
        -->
        <div
          class="card border-base-300/70 bg-base-100/92 text-base-content border backdrop-blur-2xl"
        >
          <div class="card-body gap-6 p-8">
            <div class="flex flex-col items-center gap-3">
              <img src="/logo.svg" alt="" class="size-14" />
              <div class="text-center">
                <h1 class="text-2xl font-semibold tracking-tight">Osmium</h1>
                <p class="text-sm opacity-60">{{ t('login.subtitle') }}</p>
              </div>
            </div>

            <form class="flex flex-col gap-4" @submit.prevent="submit">
              <FormField
                ref="usernameField"
                v-model="username"
                :label="t('login.username')"
                :icon="UserRound"
                type="text"
                autocomplete="username"
                required
              />

              <div class="flex flex-col gap-1.5">
                <FormField
                  v-model="password"
                  :label="t('login.password')"
                  :icon="KeyRound"
                  type="password"
                  autocomplete="current-password"
                  required
                  @keydown="trackCapsLock"
                  @keyup="trackCapsLock"
                />

                <p
                  v-if="capsLock"
                  role="status"
                  class="text-warning flex items-center gap-1.5 px-1 text-xs"
                >
                  <TriangleAlert class="size-3.5 shrink-0" />
                  {{ t('login.capsLock') }}
                </p>
              </div>

              <div v-if="error" role="alert" class="alert alert-error alert-soft">
                <CircleAlert class="size-4" />
                <span>{{ error }}</span>
              </div>

              <button class="btn btn-primary btn-block gap-2" type="submit" :disabled="busy">
                <span v-if="busy" class="loading loading-spinner loading-sm"></span>
                <LogIn v-else class="size-4" />
                {{ busy ? t('login.signingIn') : t('login.signIn') }}
              </button>
            </form>
          </div>
        </div>
      </div>

      <!--
        The dot shows in both states, green included. Same reasoning as the favicon's: with nothing
        else on the page reporting, an absent dot reads as a line that has not loaded rather than as
        a backend that is fine. It is answered by the session refresh the route guard has already
        awaited, so it is true by the time this renders.
      -->
      <div class="mt-6 flex flex-col items-center gap-1.5 text-center">
        <p
          role="status"
          class="flex items-center gap-2 text-xs"
          :class="backendReachable ? 'opacity-50' : 'text-error'"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="backendReachable ? 'bg-success' : 'bg-error'"
          ></span>
          {{ backendReachable ? t('login.reachable') : t('login.unreachable') }}
        </p>

        <p class="text-xs opacity-40">{{ t('login.noSignUp') }}</p>
      </div>
    </div>
  </div>
</template>
