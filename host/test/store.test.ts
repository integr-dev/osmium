import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LoginKind } from '../src/token/login.ts'
import { AccountStore } from '../src/token/store.ts'

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'osmium-store-'))
  path = join(directory, 'accounts.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const microsoft = (cache: string, uuid?: string) => ({
  kind: LoginKind.RefreshToken as const,
  cache,
  ...(uuid === undefined ? {} : { uuid }),
})

describe('AccountStore', () => {
  it('treats a missing file as an empty store', async () => {
    const store = await AccountStore.open(path)

    expect(store.summary()).toEqual([])
    expect(store.boundAgents()).toEqual([])
  })

  it('refuses a file it cannot make sense of, rather than starting empty', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one'))

    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{"not":"a list"}')

    await expect(AccountStore.open(path)).rejects.toThrow()
  })

  it('gives one account to one agent', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one'))

    expect(await store.claim(LoginKind.RefreshToken, 1)).toBeDefined()
    // The pool is empty now: the only account belongs to agent 1, running or not.
    expect(await store.claim(LoginKind.RefreshToken, 2)).toBeUndefined()
  })

  it('hands an agent back the account it already has', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one'))
    await store.adopt(microsoft('two'))

    const first = await store.claim(LoginKind.RefreshToken, 7)
    const again = await store.claim(LoginKind.RefreshToken, 7)

    // Setting the same agent up twice must not consume a second account.
    expect(again?.id).toBe(first?.id)
    expect(store.summary().filter((entry) => entry.agent === undefined)).toHaveLength(1)
  })

  it('remembers who owns what across a reopen', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one'))
    const claimed = await store.claim(LoginKind.RefreshToken, 26)

    const reopened = await AccountStore.open(path)

    expect(reopened.boundAgents()).toEqual([26])
    expect(reopened.restore(26)?.id).toBe(claimed?.id)
  })

  it('returns an account to the pool when its agent is deleted', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one'))
    await store.claim(LoginKind.RefreshToken, 3)

    await store.release(3)

    expect(store.boundAgents()).toEqual([])
    // The account survives: the agent being gone says nothing about whether the operator still
    // wants to play it.
    expect(store.summary()).toHaveLength(1)
    expect(await store.claim(LoginKind.RefreshToken, 4)).toBeDefined()
  })

  it('throws an offline identity away with the agent that generated it', async () => {
    const store = await AccountStore.open(path)
    await store.claim(LoginKind.NoToken, 3)
    await store.claim(LoginKind.NoToken, 4)

    expect(store.summary()).toHaveLength(2)

    await store.release(3)

    expect(store.summary()).toHaveLength(1)
    expect(store.boundAgents()).toEqual([4])
  })

  it('gives every offline agent a name of its own, and keeps it', async () => {
    const store = await AccountStore.open(path)
    const three = await store.claim(LoginKind.NoToken, 3)
    const four = await store.claim(LoginKind.NoToken, 4)

    expect(three?.username).toBeDefined()
    expect(three?.username).not.toBe(four?.username)
    expect(three!.username!.length).toBeLessThanOrEqual(16)

    const reopened = await AccountStore.open(path)
    expect(reopened.restore(3)?.username).toBe(three?.username)
  })

  it('keeps one copy of an account signed in to twice', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('first-sign-in', 'abc'))
    await store.adopt(microsoft('second-sign-in', 'abc'))

    // Two sign-ins leave two different cached secrets, so they are matched on the identity behind
    // them - otherwise the second copy could be bound to a second agent.
    expect(store.summary()).toHaveLength(1)
    expect(store.summary()[0]?.id).toBeDefined()
  })

  it('keeps both when they are different accounts', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one', 'abc'))
    await store.adopt(microsoft('two', 'def'))

    expect(store.summary()).toHaveLength(2)
  })

  it('drops one credential by id, and says when there was none', async () => {
    const store = await AccountStore.open(path)
    const entry = await store.adopt(microsoft('one'))

    expect(await store.remove(entry.id)).toBe(true)
    expect(await store.remove(entry.id)).toBe(false)
    expect(store.summary()).toEqual([])
  })

  it('does not lose what another writer added', async () => {
    const first = await AccountStore.open(path)
    const second = await AccountStore.open(path)

    // Both opened an empty store. Writing from memory would have the second overwrite the first.
    await first.adopt(microsoft('from-the-router'))
    await second.adopt(microsoft('from-osmium-link'))

    const onDisk: unknown[] = JSON.parse(await readFile(path, 'utf8'))
    expect(onDisk).toHaveLength(2)
  })

  it('keeps ids stable across processes', async () => {
    const store = await AccountStore.open(path)
    const entry = await store.adopt(microsoft('one'))

    const reopened = await AccountStore.open(path)

    // An id that is re-rolled on every read is worse than none: it is shown to an operator and
    // matches nothing by the time they use it.
    expect(reopened.summary()[0]?.id).toBe(entry.id)
  })

  it('never leaves the lock behind', async () => {
    const store = await AccountStore.open(path)
    await store.adopt(microsoft('one'))

    await expect(readFile(`${path}.lock`)).rejects.toThrow()
  })

  it('names an account once something has looked it up', async () => {
    const store = await AccountStore.open(path)
    const entry = await store.adopt(microsoft('one'))

    await store.describe(entry.id, 'MeowBot1', 'abc')

    expect(store.summary()[0]?.username).toBe('MeowBot1')
  })
})
