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
        // What the deployment is made of: the fleet, the machines under it, and the wiring.
        path: 'resources',
        name: 'resources',
        component: () => import('../views/ResourcesView.vue'),
      },
      {
        path: 'hosts/:id',
        name: 'host',
        component: () => import('../views/HostDetailView.vue'),
      },
      // Where the host table used to live. A redirect rather than a removal: it is the one path
      // an operator may have bookmarked, and a 404 would read as the page having been deleted.
      { path: 'hosts', redirect: { name: 'resources' } },
      {
        path: 'agents/:id',
        name: 'agent',
        component: () => import('../views/AgentDetailView.vue'),
      },
      {
        // Its own node, and not `agent.read`: watching makes a host follow every block change and
        // every entity movement in an agent's view for as long as this screen is open, so it can be
        // withdrawn without taking the fleet screens with it.
        path: 'agents/:id/view',
        name: 'agent-viewer',
        component: () => import('../views/AgentViewerView.vue'),
        // Full bleed: this screen is a window into somewhere, and a margin around it is world
        // nobody can see. The layout drops its padding here; the two controls float instead.
        meta: { node: 'agent.view', full: true },
      },
      {
        // Read-only, like the dashboard and hosts, so it carries no node of its own: what it draws
        // is what agents have already reported in the course of their work, and nothing on it asks
        // a host to do anything.
        //
        // Full bleed, for the reason the viewer is. This is a window onto somewhere, and a margin
        // around it is world nobody can see; the controls float over the map instead.
        path: 'map',
        name: 'map',
        component: () => import('../views/MapView.vue'),
        meta: { full: true },
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
  //
  // The node travels with the redirect. Bouncing silently meant a bookmarked `/audit` simply landed
  // on the dashboard, which reads as a broken link rather than as a restriction — and the operator
  // had no way to know they were missing an authority rather than a page.
  const node = to.meta.node as string | undefined
  return node && !auth.can(node) ? { name: 'dashboard', query: { denied: node } } : true
})
