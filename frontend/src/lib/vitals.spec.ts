import { describe, expect, it } from 'vitest'
import { dimensionLabel } from './vitals'

/**
 * The label is display only. The id is what the grouping compares positions within, so a host sends
 * `the_end` and this side decides what to call it — which is also the only way a locale gets to.
 */
describe('naming a dimension', () => {
  it('names the vanilla three', () => {
    expect(dimensionLabel('overworld')).toBe('Overworld')
    expect(dimensionLabel('the_nether')).toBe('The Nether')
    expect(dimensionLabel('the_end')).toBe('The End')
  })

  it('humanises a world nobody has a name for', () => {
    // Servers run custom worlds, and "Mining World" beats both the raw id and an empty field.
    expect(dimensionLabel('mining_world')).toBe('Mining World')
    expect(dimensionLabel('resource')).toBe('Resource')
  })

  it('drops the namespace a server may or may not send', () => {
    expect(dimensionLabel('minecraft:skyblock_void')).toBe('Skyblock Void')
  })

  it('survives what a malformed id would do to it', () => {
    expect(dimensionLabel('')).toBe('')
    expect(dimensionLabel('__')).toBe('')
  })
})
