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
        // Read-only, like the dashboard and hosts, so it carries no node of its own.
        path: 'map',
        name: 'map',
        component: () => import('../views/MapView.vue'),
      },
      {
        // Placeholder: whatever ends up here drives agents, which is the run node.
        path: 'operations',
        name: 'operations',
        component: () => import('../views/OperationsView.vue'),
        meta: { node: 'agent.run' },
      },
      {
        // Configuring an agent reshapes it rather than driving it, which is the write node.
        path: 'configuration',
        name: 'configuration',
        component: () => import('../views/ConfigurationView.vue'),
        meta: { node: 'agent.write' },
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

/**
 * The `?redirect=` the guard below sets, read back only if it is a path inside this app.
 *
 * The value reaches the login screen from the query string, so anyone can put anything in it by
 * handing out a link. vue-router neutralises most of it on its own — `javascript:alert(1)` and
 * `https://evil.com` both resolve to paths under this origin rather than navigating anywhere — but
 * **`//evil.com` survives intact**, and a leading `\` is read as `/` by browsers, so `/\evil.com`
 * is the same trick spelled differently. `history.pushState` refuses a cross-origin URL, so the
 * likely outcome is a failed navigation rather than a working open redirect; that is not a good
 * enough reason to hand an attacker-controlled string to the router.
 *
 * Returns null for anything else, and the caller falls back to the dashboard.
 */
export function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  return value
}

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // Before any decision about who this is. The access token lives in memory only, so on a reload
  // there is none until the refresh cookie has been exchanged for one - and this guard runs during
  // `app.use(router)`, ahead of anything the entry point does afterwards. Memoised, so it is one
  // request per page load rather than one per navigation.
  await auth.restore()

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
