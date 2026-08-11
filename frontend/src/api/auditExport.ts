import { token } from './token'
import { t } from '../i18n'

/**
 * Downloads the audit trail for a day range as a CSV file.
 *
 * Written against `fetch` rather than the generated client: openapi-fetch parses the body for you,
 * which is the whole point of it everywhere else and exactly wrong for an attachment. Nothing here
 * needs the schema — the response is a file, not a shape.
 *
 * The token goes in a header, so the browser cannot be pointed at the URL directly and the file
 * cannot be fetched by navigation. That is why the blob is assembled here and handed to a synthetic
 * anchor instead.
 */
export async function downloadAuditCsv(fromDay: string, toDay: string): Promise<string | null> {
  const base = import.meta.env.VITE_API_BASE_URL ?? ''
  const query = new URLSearchParams({ from: startOfDay(fromDay), to: startOfDayAfter(toDay) })

  let response: Response
  try {
    response = await fetch(`${base}/api/audit/export?${query}`, {
      headers: token.value ? { Authorization: `Bearer ${token.value}` } : {},
    })
  } catch {
    return t('errors.unreachable')
  }
  if (!response.ok) return t('errors.exportAudit')

  save(await response.blob(), fileNameOf(response) ?? `osmium-audit-${fromDay}-to-${toDay}.csv`)
  return null
}

/**
 * A picked day is a day where the operator is, not in UTC. Sending the local midnight as an instant
 * is what makes "11 August" mean the 11th of August to them; letting the backend assume UTC would
 * quietly shift the range by the offset and clip entries at both ends.
 */
function startOfDay(day: string): string {
  return new Date(`${day}T00:00:00`).toISOString()
}

/** `to` is exclusive on the wire, so the picked end day is included by asking for the next one. */
function startOfDayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00`)
  next.setDate(next.getDate() + 1)
  return next.toISOString()
}

/** The server names the file; this only reads the name back off the header it set. */
function fileNameOf(response: Response): string | null {
  const disposition = response.headers.get('content-disposition')
  return disposition?.match(/filename="?([^"]+)"?/)?.[1] ?? null
}

function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  // Released on the next frame: revoking synchronously can beat the download starting in WebKit.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}
