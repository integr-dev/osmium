import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { router } from './index'
import { token } from '../api/token'
import { respondWith } from '../test/http'

/** Signs in with exactly the nodes given, as `GET /api/auth/me` would report them. */
function signIn(nodes: string[]) {
  token.value = 'session'
  respondWith(() => ({ body: { id: 1, username: 'op', role: 'viewer', nodes } }))
}

describe('route guard', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    await router.replace('/login')
    await router.isReady()
  })

  it('sends a signed-out visitor to the login screen, remembering where they were going', async () => {
    await router.push('/accounts')

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/accounts')
  })

  it('lets a signed-out visitor reach the login screen', () => {
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('bounces a signed-in user away from the login screen', async () => {
    signIn([])
    // Navigate off /login first: vue-router discards a push to the current location without
    // running the guard, which would make this pass for the wrong reason.
    await router.push('/hosts')

    await router.push('/login')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  // The UI hides what an account cannot do, but a typed URL has to be refused as well.
  it('refuses a route whose node is missing, landing on the dashboard', async () => {
    signIn(['user.read.self'])

    await router.push('/accounts')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('admits a route whose node is granted', async () => {
    signIn(['user.read'])

    await router.push('/accounts')

    expect(router.currentRoute.value.name).toBe('accounts')
  })

  // audit.read is administrator-only and deliberately outside the agent.* tier, so an orchestrator
  // running the whole fleet still cannot read what other operators did.
  it('keeps the audit log from an account without audit.read', async () => {
    signIn(['fleet.read', 'fleet.control', 'fleet.chat', 'fleet.login'])

    await router.push('/audit')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('admits the audit log with audit.read', async () => {
    signIn(['audit.read'])

    await router.push('/audit')

    expect(router.currentRoute.value.name).toBe('audit')
  })

  // Configuring an agent is acting on it, so a viewer watching the fleet must not reach the screen
  // that does it — the same split that keeps every other way to change the fleet behind its own node.
  it('keeps configuration from an account that can only watch', async () => {
    signIn(['fleet.read'])

    await router.push('/configuration')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('admits configuration with fleet.control', async () => {
    signIn(['fleet.read', 'fleet.control'])

    await router.push('/configuration')

    expect(router.currentRoute.value.name).toBe('configuration')
  })

  /** Empty today, but gated from the start: a route that opens up later is a permission bug. */
  it('keeps operations from an account that can only watch', async () => {
    signIn(['fleet.read'])

    await router.push('/operations')

    expect(router.currentRoute.value.name).toBe('dashboard')
  })

  it('admits routes that require no node', async () => {
    signIn([])

    await router.push('/hosts')

    expect(router.currentRoute.value.name).toBe('hosts')
  })
})
