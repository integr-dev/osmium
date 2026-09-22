import { api, errorMessage } from './client'
import type { components } from './schema'

/**
 * Build plans: which schematic, where it stands, and what it is built out of.
 *
 * Nothing derived is fetched. The offset a placement implies and the material totals once
 * substitutions are applied are arithmetic over what is already loaded — see `lib/placement.ts` —
 * so they are computed rather than asked for.
 */

export type Placement = Required<components['schemas']['PlacementRequest']>

export type Substitution = Omit<Required<components['schemas']['SubstitutionRequest']>, 'to'> & {
  /** Null is a value here, not an absence: it means place nothing at all. */
  to: string | null
}

/** A box's three sides, in blocks. */
export type Size = Required<components['schemas']['SizeResponse']>

export type BuildResponse = Omit<
  Required<components['schemas']['BuildResponse']>,
  'placement' | 'substitutions' | 'serverAddress' | 'dimension' | 'size'
> & {
  placement: Placement | null
  substitutions: Substitution[]
  /** Null until somebody says which server it is for. */
  serverAddress: string | null
  /** Null until somebody says which world on it. */
  dimension: string | null
  /** The schematic's box before the turn. Null until the schematic has been read. */
  size: Size | null
}

/** Where a plan is for and which way round it goes. Blank server or world takes it back off. */
export interface PlanWorld {
  serverAddress?: string
  dimension?: string
  rotation?: number
}

export async function listBuilds(): Promise<BuildResponse[]> {
  const { data, error } = await api.GET('/api/builds')
  if (error) throw new Error(errorMessage(error))
  return (data ?? []) as BuildResponse[]
}

export async function createBuild(
  body: {
    name: string
    schematicId: number
    placement?: Placement | null
    substitutions?: Substitution[]
  } & PlanWorld,
): Promise<BuildResponse> {
  const { data, error } = await api.POST('/api/builds', { body })
  if (error) throw new Error(errorMessage(error))
  return data as BuildResponse
}

/**
 * Every field is optional and an omitted one is left alone. Placement is the exception: JSON cannot
 * tell an absent field from a null one, and the two mean opposite things, so taking a placement
 * away is asked for with `unplace` rather than inferred.
 */
export async function updateBuild(
  id: number,
  body: {
    name?: string
    placement?: Placement
    unplace?: boolean
    substitutions?: Substitution[]
  } & PlanWorld,
): Promise<BuildResponse> {
  const { data, error } = await api.PATCH('/api/builds/{id}', {
    params: { path: { id } },
    body,
  })
  if (error) throw new Error(errorMessage(error))
  return data as BuildResponse
}

export async function deleteBuild(id: number): Promise<void> {
  const { error } = await api.DELETE('/api/builds/{id}', { params: { path: { id } } })
  if (error) throw new Error(errorMessage(error))
}
