import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  candidates,
  explainMismatch,
  mismatched,
  nextVersion,
  PROVEN_MS,
  VersionMemory,
  whyFellBack,
} from '../src/agent/versions.ts'

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

  /** A server answering the question outranks anything guessed from the outside. */
  it('takes what the ping said, over what worked here before', () => {
    expect(nextVersion({ known: '1.21.4', hinted: '1.20.4', list })).toBe('1.20.4')
  })

  it('takes what the ping said when nothing is known', () => {
    expect(nextVersion({ hinted: '1.20.4', list })).toBe('1.20.4')
  })

  /**
   * The newest protocol opens, and the memory catches.
   *
   * A server whose proxy has been updated since an agent last played on it should be spoken to in
   * the version it now prefers, and an operator should not have to empty a cache file to ask for
   * that. So what worked before is the second thing tried rather than the first.
   */
  it('opens with the newest protocol rather than the remembered one', () => {
    expect(nextVersion({ known: '1.21.4', list })).toBe('26.1')
  })

  it('falls back to the remembered one as soon as the newest is refused', () => {
    expect(nextVersion({ known: '1.21.4', tried: ['26.1'], list })).toBe('1.21.4')
  })

  /** And the rest of the list is behind it, so a wrong memory still ends in a search. */
  it('carries on down the list once the memory has been tried too', () => {
    expect(nextVersion({ known: '1.21.4', tried: ['26.1', '1.21.4'], list })).toBe('1.21.8')
  })

  it('works down the list, skipping everything already tried', () => {
    expect(nextVersion({ tried: ['26.1'], list })).toBe('1.21.8')
    expect(nextVersion({ tried: ['26.1', '1.21.8'], list })).toBe('1.21.4')
  })

  /** Including the remembered one and the hint: a search that retried them would never move on. */
  it('does not offer a remembered or hinted version twice', () => {
    expect(nextVersion({ known: '1.21.8', tried: ['26.1', '1.21.8'], list })).toBe('1.21.4')
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

/**
 * Telling "the version is wrong" apart from "the server did not want us".
 *
 * The two want opposite things. A kick or a dropped socket is a reason to rejoin exactly as we
 * were; a stream read against the wrong shape is the only reason to stop believing the version.
 *
 * This is the one that made a working memory go bad: a pinned 26.1 logged in fine, died a hundred
 * seconds later on the first item carrying components, and was written down as good because it had
 * reached play.
 */
describe('a death that means the version was wrong', () => {
  it('knows the reader complaining about a field it cannot make sense of', () => {
    expect(
      mismatched(
        'Parse error for play.toClient: Read error for undefined : array size is abnormally large, not reading: 90536052',
      ),
    ).toBe(true)
  })

  it('knows the rest of that family', () => {
    expect(mismatched('PartialReadError: Read error for undefined')).toBe(true)
    expect(mismatched('Unexpected buffer end while reading packet')).toBe(true)
    expect(mismatched('Deserialization error in packet map_chunk')).toBe(true)
  })

  /** Every one of these is a reason to rejoin as we were, and none is a reason to re-search. */
  it('leaves an ordinary ending alone', () => {
    expect(mismatched('socket closed')).toBe(false)
    expect(mismatched('You have been banned from this server')).toBe(false)
    expect(mismatched('Timed out waiting for chunks')).toBe(false)
    expect(mismatched('Server is full')).toBe(false)
    expect(mismatched(undefined)).toBe(false)
    expect(mismatched('')).toBe(false)
  })

  /** Observed at 104 seconds, so the mark has to sit well past it. */
  it('waits longer than the death it exists to catch', () => {
    expect(PROVEN_MS).toBeGreaterThan(104_000)
  })
})

describe('saying what a mismatch was', () => {
  const said = explainMismatch('26.1', 'play.example.com')

  it('names the version, the server and the thing that disagrees', () => {
    expect(said).toContain('26.1')
    expect(said).toContain('play.example.com')
    expect(said).toContain('component')
  })

  /** The point of it: an operator should not have to read this as an array-length complaint. */
  it('says nothing about array sizes', () => {
    expect(said).not.toContain('array size')
  })
})

/**
 * The clause the join line carries when the version was not the first choice.
 *
 * `Joined ... on 1.21.11` reads identically whether that was asked for or arrived at, and the two
 * mean different things. The failure that caused it is several messages back by then.
 */
describe('saying why it fell back', () => {
  it('names the version it came off, and that items are the reason', () => {
    const said = whyFellBack('26.1', true)

    expect(said).toContain('26.1')
    expect(said).toContain('item data')
  })

  /** A refusal is a different fact from a version that reads items wrong, and reads differently. */
  it('says something else for a version the server would not have', () => {
    const said = whyFellBack('26.1', false)

    expect(said).toContain('26.1')
    expect(said).not.toContain('item data')
  })
})
