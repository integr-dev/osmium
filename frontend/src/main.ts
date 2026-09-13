import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'
import { setUnauthorizedHandler } from './api/client'
import { useAuthStore } from './stores/auth'
import { useToastStore } from './stores/toasts'
import { startTheme } from './lib/theme'

// Before anything mounts. The page is already in the right theme - see `public/theme.js` - so this
// only starts following the operating system for an operator on System.
startTheme()

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)

setUnauthorizedHandler(() => {
  void useAuthStore().logout()
  void router.push({ name: 'login' })
})

/**
 * A console handle on the notices, in development only.
 *
 * They are raised by things that are awkward to stage on purpose — a host falling over, the last
 * piece of a job landing — and the behaviour worth checking is what the *stack* does: three at a
 * time, a repeat folding into the one already up, every clock stopping under the pointer. That
 * needs several at once, on demand.
 *
 * `import.meta.env.DEV` is a compile-time constant, so this whole block is gone from a production
 * bundle rather than merely unreachable in one.
 */
if (import.meta.env.DEV) {
  Object.assign(window, {
    osmium: {
      toast: (kind: 'success' | 'info' | 'warning' | 'error', key: string, name = 'oslo-1') =>
        useToastStore().notify(kind, key, { params: { name } }),
    },
  })
}

/**
 * Resuming the session is the **route guard's** job, not this file's.
 *
 * `app.use(router)` above already started vue-router's initial navigation, so anything awaited here
 * would land after the guard had already decided the operator was signed out. See
 * `router.beforeEach`.
 */
app.mount('#app')
