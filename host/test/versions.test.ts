import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { candidates, nextVersion, VersionMemory } from '../src/agent/versions.ts'

/**
 * Finding out what a masked server speaks.
 *
 * ViaVersion answers a status ping with protocol `9999` and a version name that is usually a
 * decorated player count, so there is nothing to negotiate from. What is tested here is the search
 * that replaces the guess, and the memory that stops it happening twice.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'osmium-versions-'))
}

describe('the versions worth trying', () => {
  const list = candidates()

  /** The bug this whole thing exists for: 1.21.4 and 1.21.11 are the same line and not the same protocol. */
  it('keeps every protocol of a release line, not one version of it', () => {
    expect(list).toContain('1.21.4')
    expect(list).toContain('1.21.8')
    expect(list.filter((version) => version.startsWith('1.21')).length).toBeGreaterThan(4)
  })

  it('puts the newest protocol first', () => {
    expect(list[0]).toBe('26.1')
    expect(list.indexOf('1.21.4')).toBeLessThan(list.indexOf('1.20.4'))
  })

  /** A snapshot is spoken by nothing anybody joins, and would spend the search's budget. */
  it('offers releases only', () => {
    for (const version of list) expect(version).toMatch(/^\d+\.\d+(\.\d+)?$/)
  })

  it('names each version once', () => {
    expect(new Set(list).size).toBe(list.length)
  })
})

describe('choosing the next one', () => {
  const list = ['26.1', '1.21.8', '1.21.4', '1.20.4']

  /** Evidence beats a guess: something actually played on it. */
  it('takes what worked here before, over what the ping said', () => {
    expect(nextVersion({ known: '1.21.4', hinted: '26.1', list })).toBe('1.21.4')
  })

  it('takes what the ping said when nothing is known', () => {
    expect(nextVersion({ hinted: '1.20.4', list })).toBe('1.20.4')
  })

  it('works down the list, skipping everything already tried', () => {
    expect(nextVersion({ tried: ['26.1'], list })).toBe('1.21.8')
    expect(nextVersion({ tried: ['26.1', '1.21.8'], list })).toBe('1.21.4')
  })

  /** Including the remembered one and the hint: a search that retried them would never move on. */
  it('does not offer a remembered or hinted version twice', () => {
    expect(nextVersion({ known: '1.21.4', tried: ['1.21.4'], list })).toBe('26.1')
    expect(nextVersion({ hinted: '26.1', tried: ['26.1'], list })).toBe('1.21.8')
  })

  it('is nothing at all once everything has been tried', () => {
    expect(nextVersion({ tried: list, list })).toBeUndefined()
  })
})

describe('what each server turned out to speak', () => {
  it('remembers across restarts', () => {
    const directory = scratch()

    new VersionMemory(directory).remember('play.example:25565', '1.21.4')

    expect(new VersionMemory(directory).recall('play.example:25565')).toBe('1.21.4')
  })

  it('knows nothing about a server nobody has played on', () => {
    expect(new VersionMemory(scratch()).recall('play.example:25565')).toBeUndefined()
  })

  /** A server that updates is the ordinary reason, and a memory that cannot be wrong pins an agent. */
  it('forgets one that stopped working', () => {
    const directory = scratch()
    const memory = new VersionMemory(directory)

    memory.remember('play.example:25565', '1.21.4')
    memory.forget('play.example:25565')

    expect(memory.recall('play.example:25565')).toBeUndefined()
    expect(new VersionMemory(directory).recall('play.example:25565')).toBeUndefined()
  })

  /** Written through on every change: a host is killed at least as often as it is stopped politely. */
  it('writes as it learns rather than at the end', () => {
    const directory = scratch()
    const memory = new VersionMemory(directory)

    memory.remember('one.example:25565', '1.21.4')
    memory.remember('two.example:25565', '1.20.4')

    const stored = JSON.parse(readFileSync(join(directory, 'versions.json'), 'utf8')) as Record<string, string>
    expect(stored).toEqual({ 'one.example:25565': '1.21.4', 'two.example:25565': '1.20.4' })
  })

  /** What it costs to be wrong here is a search that happens again, which is not worth throwing over. */
  it('survives a file that is not what it expected', () => {
    const directory = scratch()
    writeFileSync(join(directory, 'versions.json'), 'not json at all')

    const memory = new VersionMemory(directory)

    expect(memory.recall('play.example:25565')).toBeUndefined()
    expect(() => memory.remember('play.example:25565', '1.21.4')).not.toThrow()
  })

  it('works with nowhere to write, for a host with no cache directory', () => {
    const memory = new VersionMemory(undefined)

    memory.remember('play.example:25565', '1.21.4')

    expect(memory.recall('play.example:25565')).toBe('1.21.4')
  })
})
