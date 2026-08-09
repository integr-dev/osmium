import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AppLayout from '../layouts/AppLayout.vue'
import { useAuthStore } from '../stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', redirect: { name: 'dashboard' } },
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('../views/DashboardView.vue'),
      },
      {
        path: 'hosts',
        name: 'hosts',
        component: () => import('../views/HostsView.vue'),
      },
      {
        path: 'bots/:id',
        name: 'bot',
        component: () => import('../views/BotDetailView.vue'),
      },
      {
        path: 'account',
        name: 'account',
        component: () => import('../views/MyAccountView.vue'),
      },
      {
        path: 'accounts',
        name: 'accounts',
        component: () => import('../views/AllAccountsView.vue'),
        meta: { node: 'user.read' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('../views/SettingsView.vue'),
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'dashboard' } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (to.meta.public) {
    return auth.isAuthenticated ? { name: 'dashboard' } : true
  }
  if (!auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  await auth.ensureLoaded()

  // Dashboard needs no node, so it is the safe landing spot when one is missing.
  const node = to.meta.node as string | undefined
  return node && !auth.can(node) ? { name: 'dashboard' } : true
})
