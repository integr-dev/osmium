import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'
import { setUnauthorizedHandler } from './api/client'
import { useAuthStore } from './stores/auth'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)

setUnauthorizedHandler(() => {
  void useAuthStore().logout()
  void router.push({ name: 'login' })
})

/**
 * Resuming the session is the **route guard's** job, not this file's.
 *
 * `app.use(router)` above already started vue-router's initial navigation, so anything awaited here
 * would land after the guard had already decided the operator was signed out. See
 * `router.beforeEach`.
 */
app.mount('#app')
