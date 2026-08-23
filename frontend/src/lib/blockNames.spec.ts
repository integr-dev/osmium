import { describe, expect, it } from 'vitest'
import { blockId, blockName, isKnownBlock, searchBlocks } from './blockNames'

describe('blockName', () => {
  it('gives the name a person would recognise', () => {
    expect(blockName('minecraft:white_terracotta')).toBe('White Terracotta')
    expect(blockName('minecraft:oak_log')).toBe('Oak Log')
  })

  it('does not care whether the namespace is there', () => {
    expect(blockName('stone')).toBe(blockName('minecraft:stone'))
  })

  /**
   * The dataset lags the game, and a schematic can legitimately contain a block newer than it. An
   * unknown block is not an error and must not render as one — it is shown, made readable.
   */
  it('prettifies a block it has never heard of rather than failing', () => {
    expect(blockName('minecraft:some_future_block')).toBe('Some Future Block')
    expect(isKnownBlock('minecraft:some_future_block')).toBe(false)
    expect(isKnownBlock('minecraft:stone')).toBe(true)
  })

  it('never returns nothing, whatever it is handed', () => {
    expect(blockName('')).toBe('')
    expect(blockName('minecraft:')).toBe('')
    expect(blockName('weird__double__underscores')).toBe('Weird Double Underscores')
  })

  it('strips only the namespace', () => {
    expect(blockId('minecraft:stone')).toBe('stone')
    expect(blockId('stone')).toBe('stone')
    // A modded namespace is left alone: it is part of what identifies the block.
    expect(blockId('create:andesite_casing')).toBe('create:andesite_casing')
  })
})

describe('searchBlocks', () => {
  it('puts an exact id first', () => {
    // The whole point of ranking: `stone` must not be buried under its own variants.
    expect(searchBlocks('stone')[0]).toEqual({ id: 'stone', name: 'Stone' })
  })

  it('matches what somebody actually types, spaces and all', () => {
    const spaced = searchBlocks('white terra')
    const under = searchBlocks('white_terra')

    expect(spaced.map((match) => match.id)).toContain('white_terracotta')
    expect(under.map((match) => match.id)).toContain('white_terracotta')
  })

  it('finds a block by its display name, not only by its id', () => {
    // Somebody reading the interface knows "Terracotta", not `terracotta`.
    expect(searchBlocks('Terracotta').length).toBeGreaterThan(0)
    expect(searchBlocks('Terracotta').every((match) => /terracotta/.test(match.id))).toBe(true)
  })

  it('prefers a word starting with the query to one merely containing it', () => {
    const ids = searchBlocks('brick', 30).map((match) => match.id)
    // `brick` before `nether_brick`: the plain material beats the modified one.
    expect(ids.indexOf('bricks')).toBeLessThan(ids.indexOf('nether_bricks'))
  })

  it('honours the limit and returns something for an empty query', () => {
    expect(searchBlocks('stone', 3)).toHaveLength(3)
    // An empty box should offer a starting point rather than nothing at all.
    expect(searchBlocks('', 5)).toHaveLength(5)
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(searchBlocks('zzzzzzzznotablock')).toEqual([])
  })

  it('is case insensitive', () => {
    expect(searchBlocks('STONE')[0].id).toBe('stone')
  })
})
