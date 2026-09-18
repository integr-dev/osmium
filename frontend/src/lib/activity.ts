import type { ActivityEntryResponse } from '../api/client'

/**
 * How an incident's severity is drawn, in one place.
 *
 * The dashboard and an agent's own page show the same feed at different scopes, and both had their
 * own copy of this table — which is how a warning ends up amber in one list and yellow in the other.
 */

export type Severity = ActivityEntryResponse['severity']

/** Worst first, which is the order the filter chips and the chart legend read in. */
export const SEVERITIES: readonly Severity[] = ['ERROR', 'WARNING', 'INFO']

/** As a background: the dot on a feed row. */
export const SEVERITY_DOT: Record<Severity, string> = {
  INFO: 'bg-base-content/30',
  WARNING: 'bg-warning',
  ERROR: 'bg-error',
}

/** The same three as text, for a chip's mark and a chart's line. */
export const SEVERITY_TONE: Record<Severity, string> = {
  INFO: 'text-base-content/40',
  WARNING: 'text-warning',
  ERROR: 'text-error',
}
