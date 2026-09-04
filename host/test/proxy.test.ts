import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { Proxies, ProxyStore, unusable } from '../src/agent/proxy.ts'

/**
 * The proxy file, which is the one part of routing that is this host's own judgement.
 *
 * Everything after it is a socket someone else opens. What is decided here is what counts as a
 * usable entry, and the answers matter twice over: a proxy silently dropped is an agent that will
 * not connect, and a proxy silently *kept* when it is malformed is a connection that goes out from
 * this machine's own address, which is the one outcome the whole feature exists to prevent.
 */
describe('the proxy file', () => {
  async function written(content: string): Promise<Proxies> {
    const directory = await mkdtemp(join(tmpdir(), 'osmium-proxies-'))
    const path = join(directory, 'proxies.json')
    await writeFile(path, content, 'utf8')
    return Proxies.open(path)
  }

  it('reads a proxy and offers it by name', async () => {
    const held = await written(
      JSON.stringify([{ name: 'resi-eu', kind: 'socks5', host: '10.0.0.9', port: 1080 }]),
    )

    const found = held.find('resi-eu')
    expect(found?.host).toBe('10.0.0.9')
    expect(found?.port).toBe(1080)
    expect(found?.kind).toBe('socks5')
  })

  /** Providers hand out whatever port they feel like, so nothing here is allowed to assume 1080. */
  it('takes any port a provider might hand out', async () => {
    const held = await written(
      JSON.stringify([
        { name: 'a', kind: 'socks5', host: 'p', port: 1 },
        { name: 'b', kind: 'http', host: 'p', port: 8080 },
        { name: 'c', kind: 'https', host: 'p', port: 65535 },
        { name: 'd', kind: 'socks4', host: 'p', port: 9050 },
      ]),
    )

    expect(held.advertised().map((proxy) => proxy.port)).toEqual([1, 8080, 65535, 9050])
    expect(held.advertised().map((proxy) => proxy.kind)).toEqual(['socks5', 'http', 'https', 'socks4'])
  })

  /** SOCKS5 is what a provider means when it says nothing, and it is what most of them sell. */
  it('assumes socks5 when no kind is written', async () => {
    const held = await written(JSON.stringify([{ name: 'plain', host: 'p', port: 1080 }]))
    expect(held.find('plain')?.kind).toBe('socks5')
  })

  it('drops entries that could not be dialled, and keeps the rest', async () => {
    const held = await written(
      JSON.stringify([
        { name: 'no-host', kind: 'socks5', port: 1080 },
        { name: 'bad-port', kind: 'socks5', host: 'p', port: 70000 },
        { name: 'unwritable-port', kind: 'socks5', host: 'p', port: 'eighty' },
        { name: 'bad-kind', kind: 'carrier-pigeon', host: 'p', port: 1080 },
        { kind: 'socks5', host: 'p', port: 1080 },
        { name: 'good', kind: 'socks5', host: 'p', port: 1080 },
      ]),
    )

    expect(held.advertised().map((proxy) => proxy.name)).toEqual(['good'])
  })

  /** Two proxies under one name is a file somebody edited twice; the second cannot be chosen. */
  it('keeps the first of two proxies sharing a name', async () => {
    const held = await written(
      JSON.stringify([
        { name: 'dup', kind: 'socks5', host: 'first', port: 1080 },
        { name: 'dup', kind: 'socks5', host: 'second', port: 1080 },
      ]),
    )

    expect(held.find('dup')?.host).toBe('first')
  })

  /**
   * The whole point of the file living here. What crosses to the backend says a proxy authenticates
   * without saying what with, and the address is not a secret - the credential is.
   */
  it('advertises that a proxy authenticates, never how', async () => {
    const held = await written(
      JSON.stringify([
        { name: 'paid', kind: 'socks5', host: 'p', port: 1080, username: 'erik', password: 'hunter2' },
        { name: 'open', kind: 'socks5', host: 'p', port: 1080 },
      ]),
    )

    const advertised = held.advertised()
    expect(advertised.map((proxy) => proxy.authenticated)).toEqual([true, false])
    expect(JSON.stringify(advertised)).not.toContain('hunter2')
    expect(JSON.stringify(advertised)).not.toContain('erik')
  })

  it('holds nothing when there is no file, rather than failing to start', async () => {
    const held = await Proxies.open(join(tmpdir(), 'osmium-proxies-does-not-exist', 'proxies.json'))
    expect(held.advertised()).toEqual([])
    expect(held.find('anything')).toBeUndefined()
  })

  it('holds nothing when the file is not JSON', async () => {
    const held = await written('this is not json')
    expect(held.advertised()).toEqual([])
  })
})

/**
 * The writable side, which `osmium-link` drives.
 *
 * The store and the router read the same file, so what matters here is that a write leaves
 * something the router would accept, and that a change is made against what is on disk rather than
 * against what this process last saw - the file is edited by hand while a router is running.
 */
describe('the proxy store', () => {
  async function sandbox(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'osmium-store-'))
    return join(directory, 'proxies.json')
  }

  it('writes a proxy the router will read back', async () => {
    const path = await sandbox()
    const store = await ProxyStore.open(path)

    await store.add({ name: 'resi-eu', kind: 'socks5', host: '10.0.0.9', port: 1080, username: 'erik', password: 'hunter2' })

    const router = await Proxies.open(path)
    expect(router.find('resi-eu')?.port).toBe(1080)
    expect(router.find('resi-eu')?.password).toBe('hunter2')
    expect(router.advertised()[0]?.authenticated).toBe(true)
  })

  /** A name is what an agent's setting holds, so silently repointing one is not a thing to allow. */
  it('refuses a name that is already taken', async () => {
    const path = await sandbox()
    const store = await ProxyStore.open(path)

    await store.add({ name: 'dup', kind: 'socks5', host: 'a', port: 1080 })
    await expect(store.add({ name: 'dup', kind: 'socks5', host: 'b', port: 1080 })).rejects.toThrow(/already/)

    expect((await Proxies.open(path)).find('dup')?.host).toBe('a')
  })

  it('removes by name, and says when there was nothing to remove', async () => {
    const path = await sandbox()
    const store = await ProxyStore.open(path)

    await store.add({ name: 'gone', kind: 'http', host: 'a', port: 8080 })

    expect(await store.remove('gone')).toBe(true)
    expect(await store.remove('gone')).toBe(false)
    expect(store.list()).toEqual([])
  })

  /**
   * The reason every change is a read-modify-write: `osmium-link` and the router hold the same file,
   * and so do two people in two shells. A write of what this process happened to load is how the
   * other one's proxy disappears.
   */
  it('keeps what somebody else wrote while it was open', async () => {
    const path = await sandbox()
    const store = await ProxyStore.open(path)
    await store.add({ name: 'mine', kind: 'socks5', host: 'a', port: 1080 })

    // Another shell, holding the same file.
    const other = await ProxyStore.open(path)
    await other.add({ name: 'theirs', kind: 'socks5', host: 'b', port: 1080 })

    await store.add({ name: 'later', kind: 'socks5', host: 'c', port: 1080 })

    const names = (await ProxyStore.open(path)).list().map((proxy) => proxy.name)
    expect(names).toEqual(['mine', 'theirs', 'later'])
  })
})

describe('what counts as dialable', () => {
  it('accepts what the router would accept', () => {
    expect(unusable({ name: 'a', kind: 'socks5', host: 'h', port: 1080 })).toBeUndefined()
    expect(unusable({ name: 'a', kind: 'https', host: 'h', port: 65535 })).toBeUndefined()
  })

  it('names what is wrong, so a prompt can say it back', () => {
    expect(unusable({ name: '', kind: 'socks5', host: 'h', port: 1080 })).toMatch(/name/)
    expect(unusable({ name: 'a', kind: 'socks5', host: '', port: 1080 })).toMatch(/host/)
    expect(unusable({ name: 'a', kind: 'socks5', host: 'h', port: 0 })).toMatch(/port/)
    expect(unusable({ name: 'a', kind: 'socks5', host: 'h', port: 70000 })).toMatch(/port/)
    expect(unusable({ name: 'a', kind: 'carrier-pigeon', host: 'h', port: 1080 })).toMatch(/socks5/)
  })
})
