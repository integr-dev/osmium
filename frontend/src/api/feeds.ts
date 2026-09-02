import {
  api,
  errorMessage,
  type ActivityEntryResponse,
  type AuditEntryResponse,
  type ChatMessageResponse,
} from './client'
import type { FeedPage } from '../lib/feed'
import { t } from '../i18n'

/**
 * The three cursor-paged feeds, in the shape `useFeed` wants.
 *
 * They are gathered here rather than left in each view because they share one contract — `limit`,
 * `cursor`, `{ items, nextCursor }` — and reading them side by side is what keeps that true.
 */

/** One request should fill a tall window, so reaching the bottom is rare rather than constant. */
export const PAGE_SIZE = 100

type Result<T> = FeedPage<T> | { error: string }

export async function fetchAuditPage(
  cursor: string | null,
  query?: string,
): Promise<Result<AuditEntryResponse>> {
  const { data, error } = await api.GET('/api/audit', {
    params: { query: { limit: PAGE_SIZE, cursor: cursor ?? undefined, query: query || undefined } },
  })
  if (error) return { error: errorMessage(error, t('errors.loadAudit')) }
  return page(data?.items as AuditEntryResponse[] | undefined, data?.nextCursor)
}

export async function fetchActivityPage(
  cursor: string | null,
  agentId?: number,
): Promise<Result<ActivityEntryResponse>> {
  const { data, error } = await api.GET('/api/activity', {
    params: { query: { limit: PAGE_SIZE, cursor: cursor ?? undefined, agentId } },
  })
  if (error) return { error: errorMessage(error, t('errors.loadActivity')) }
  return page(data?.items as ActivityEntryResponse[] | undefined, data?.nextCursor)
}

/**
 * One of `agentId` or `server`, which is what the endpoint enforces - except when searching, where
 * neither is allowed and the search spans every server the fleet was listening to. An agent's feed
 * is the conversation to or about it; a server's feed is the global chat everyone there saw.
 */
export async function fetchChatPage(
  cursor: string | null,
  filter: { agentId: number } | { server: string } | Record<string, never>,
  query?: string,
): Promise<Result<ChatMessageResponse>> {
  const { data, error } = await api.GET('/api/chat', {
    params: {
      query: {
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        // Blank is somebody clearing the box, and the endpoint refuses it - so it is not sent.
        query: query?.trim() ? query.trim() : undefined,
        ...filter,
      },
    },
  })
  if (error) return { error: errorMessage(error, t('errors.loadChat')) }
  return page(data?.items as ChatMessageResponse[] | undefined, data?.nextCursor)
}

/** The document marks both fields optional; the backend always sends them. */
function page<T>(items: T[] | undefined, nextCursor: string | null | undefined): FeedPage<T> {
  return { items: items ?? [], nextCursor: nextCursor ?? null }
}
