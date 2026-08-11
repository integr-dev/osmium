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
        path: 'agents/:id',
        name: 'agent',
        component: () => import('../views/AgentDetailView.vue'),
      },
      {
        // Configuring an agent is acting on it, so it sits behind the same node as connecting one.
        path: 'agent-settings',
        name: 'agentSettings',
        component: () => import('../views/AgentSettingsView.vue'),
        meta: { node: 'fleet.control' },
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
        path: 'audit',
        name: 'audit',
        component: () => import('../views/AuditView.vue'),
        meta: { node: 'audit.read' },
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
