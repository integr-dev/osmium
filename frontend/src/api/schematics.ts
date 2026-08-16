import {
  api,
  errorMessage,
  type SchematicResponse,
  type ShapeResponse,
  type SplitResponse,
} from './client'
import { apiBaseUrl } from './base'
import { token } from './token'
import { t } from '../i18n'

export type { SchematicResponse, ShapeResponse, SplitResponse }

/**
 * Sending a schematic, which is the one request in Osmium that can run for an hour.
 *
 * Not one PUT of a file. A multi-gigabyte upload over a domestic connection has exactly one failure
 * mode — losing all of it at 90% — so the file goes in chunks at explicit offsets, and a chunk that
 * does not continue where the last one left off is answered with the offset that does. Resuming is
 * then one round trip rather than a second call to ask where we were.
 */

/** Big enough that the per-request overhead disappears, small enough to lose little on a retry. */
const CHUNK = 8 * 1024 * 1024

/** How the backend says "not there, here" when an offset does not line up. */
const EXPECTED_OFFSET = 'x-osmium-expected-offset'

export interface UploadProgress {
  sent: number
  total: number
}

export async function listSchematics(): Promise<SchematicResponse[]> {
  const { data, error } = await api.GET('/api/schematics')
  if (error) throw new Error(errorMessage(error))
  return (data ?? []) as SchematicResponse[]
}

export async function renameSchematic(id: number, name: string): Promise<SchematicResponse> {
  const { data, error } = await api.PATCH('/api/schematics/{id}', {
    params: { path: { id } },
    body: { name },
  })
  if (error) throw new Error(errorMessage(error))
  return data as SchematicResponse
}

export async function deleteSchematic(id: number): Promise<void> {
  const { error } = await api.DELETE('/api/schematics/{id}', { params: { path: { id } } })
  if (error) throw new Error(errorMessage(error))
}

export async function schematicMaterials(id: number) {
  const { data, error } = await api.GET('/api/schematics/{id}/materials', {
    params: { path: { id } },
  })
  if (error) throw new Error(errorMessage(error))
  return data ?? []
}

/**
 * Uploads a file, resuming where it left off if a chunk is refused.
 *
 * `signal` cancels it mid-flight. The schematic stays behind at whatever offset it reached, which
 * is the point: cancelling an upload should leave something to continue rather than something to
 * clean up.
 */
export async function uploadSchematic(options: {
  name: string
  file: File
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}): Promise<SchematicResponse> {
  const { name, file, onProgress, signal } = options

  const { data, error } = await api.POST('/api/schematics', {
    body: { name, filename: file.name, sizeBytes: file.size },
  })
  if (error) throw new Error(errorMessage(error))

  let schematic = data as SchematicResponse
  let offset = schematic.receivedBytes

  while (offset < file.size) {
    signal?.throwIfAborted()

    const end = Math.min(offset + CHUNK, file.size)
    const response = await send(schematic.id, offset, file.slice(offset, end), signal)

    if (response.status === 409) {
      // The backend knows better than we do. Written as a jump rather than a failure because this
      // is the ordinary case after a dropped connection, not an error to report.
      const actual = response.headers.get(EXPECTED_OFFSET)
      if (actual === null) throw new Error(await messageOf(response))
      offset = Number(actual)
      continue
    }
    if (!response.ok) throw new Error(await messageOf(response))

    schematic = (await response.json()) as SchematicResponse
    offset = schematic.receivedBytes
    onProgress?.({ sent: offset, total: file.size })
  }

  return schematic
}

/**
 * Written against `fetch` rather than the generated client. The body is raw bytes: openapi-fetch
 * serialises what it is given, which is the point of it everywhere else and exactly wrong for a
 * slice of a file that must go up untouched.
 */
async function send(
  id: number,
  offset: number,
  chunk: Blob,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(`${apiBaseUrl}/api/schematics/${id}/content?offset=${offset}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
      },
      body: chunk,
      signal,
    })
  } catch (failure) {
    if (signal?.aborted) throw failure
    throw new Error(t('errors.unreachable'))
  }
}

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }
    return body.message ?? t('errors.generic')
  } catch {
    return t('errors.generic')
  }
}

export type SplitMode = 'COLUMNS' | 'LAYERS' | 'GRID'

/**
 * How a build divides between a number of agents.
 *
 * A GET because it asks rather than acts: the answer is a pure function of the schematic and the
 * two arguments, nothing is stored, and asking again gives the same segments. That is also what
 * lets the preview be re-fetched freely as the operator tries modes against each other.
 */
export async function splitSchematic(
  id: number,
  mode: SplitMode,
  parts: number,
): Promise<SplitResponse> {
  const { data, error } = await api.GET('/api/schematics/{id}/split', {
    params: { path: { id }, query: { mode, parts } },
  })
  if (error) throw new Error(errorMessage(error))
  return data as SplitResponse
}

/**
 * The schematic as a voxel model.
 *
 * `detail` is voxels along the longest axis, which bounds what comes back rather than describing
 * what is in the file — the same schematic at 32 and at 96 is one building at two resolutions.
 */
export async function schematicShape(id: number, detail = 64): Promise<ShapeResponse> {
  const { data, error } = await api.GET('/api/schematics/{id}/shape', {
    params: { path: { id }, query: { detail } },
  })
  if (error) throw new Error(errorMessage(error))
  return data as ShapeResponse
}

/**
 * Reads an already-uploaded file again.
 *
 * The file is the durable thing and everything else is derived from it, so a schematic read before
 * the index learned to record something describes less than it could. This is the alternative to
 * sending gigabytes again to recompute what is already on disk.
 */
export async function reanalyseSchematic(id: number): Promise<SchematicResponse> {
  const { data, error } = await api.POST('/api/schematics/{id}/reanalyse', {
    params: { path: { id } },
  })
  if (error) throw new Error(errorMessage(error))
  return data as SchematicResponse
}
