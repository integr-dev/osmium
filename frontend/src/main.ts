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
  useAuthStore().logout()
  void router.push({ name: 'login' })
})

app.mount('#app')
