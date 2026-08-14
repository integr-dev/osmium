import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { backendReachable } from '../api/client'
import { t } from '../i18n'
import { useAgentStore } from '../stores/agents'
import { useAuthStore } from '../stores/auth'

/**
 * What the tab says while nobody is looking at the page.
 *
 * A fleet is watched out of the corner of an eye — the operator has this open behind an editor and a
 * game client — so the two things the browser shows a background tab are worth using: the title, and
 * the icon.
 */
export type ConnectionStatus = 'ok' | 'stale' | 'offline'

export interface FleetSummary {
  reachable: boolean
  /** False before sign-in, or for an account without `fleet.read`: there is nothing to report. */
  hasFleet: boolean
  online: number
  total: number
  percent: number
  etaMinutes: number | null
}

/**
 * The titles to rotate through, in order.
 *
 * A broken backend gets one frame and no rotation: a title cycling through numbers that stopped
 * being true is worse than no numbers, and the one fact worth carrying is that it is not answering.
 */
export function titleFrames(summary: FleetSummary): string[] {
  // Every frame keeps the name in front of it: a tab that reads "62% built" on its own says nothing
  // about which of a dozen tabs it is, which is the first thing a tab has to answer.
  const prefixed = (text: string) => t('title.prefixed', { text })

  if (!summary.reachable) return [prefixed(t('title.offline'))]
  if (!summary.hasFleet || summary.total === 0) return [t('title.plain')]

  const frames = [
    t('title.plain'),
    prefixed(t('title.online', { online: summary.online, total: summary.total })),
    prefixed(t('title.built', { percent: summary.percent })),
  ]

  // Null while nothing is being placed, which is most of the time. An ETA of "—" is not a frame.
  if (summary.etaMinutes !== null) {
    frames.push(prefixed(t('title.eta', { minutes: summary.etaMinutes })))
  }
  return frames
}

/**
 * The logo with a status dot on it, as SVG text.
 *
 * Built by splicing into the file rather than by drawing on a canvas: an SVG favicon stays sharp on
 * a scaled display, and the alternative rasterises the mark at 32px and hopes.
 *
 * The dot is always there, green included. This is the one place in the interface where that is
 * right — a tab sits in a strip of other tabs with nothing else to say, so an absent dot would read
 * as an icon that has not loaded rather than as a fleet that is fine.
 */
export function faviconSvg(source: string, status: ConnectionStatus): string {
  // A ring in the page background separates the dot from whatever it lands on, which at 16px is the
  // difference between a status and a smudge.
  const badge =
    `<circle cx="${DOT_X}" cy="${DOT_Y}" r="${DOT_RADIUS + DOT_RING}" fill="${DOT_BACKDROP}"/>` +
    `<circle cx="${DOT_X}" cy="${DOT_Y}" r="${DOT_RADIUS}" fill="${DOT_FILL[status]}"/>`

  return source.replace('</svg>', `${badge}</svg>`)
}

/** Bottom-right of the 899×846 viewBox `logo.svg` declares. */
const DOT_X = 690
const DOT_Y = 640
const DOT_RADIUS = 195
const DOT_RING = 55

// The theme's own `--color-success`, `--color-warning`, `--color-error` and `--color-base-100`, as
// hex: a favicon is fetched as a file and never sees the stylesheet's custom properties. Success is
// the theme's green rather than the brand one, which is the logo's own colour and would vanish
// into it.
const DOT_FILL: Record<ConnectionStatus, string> = {
  ok: '#6ee7a0',
  stale: '#f2e35c',
  offline: '#f4a7a3',
}

const DOT_BACKDROP = '#141a15'

/**
 * Keeps the tab's title and icon telling the truth.
 *
 * Mounted once, at the root, so it covers the login screen as well — an operator who cannot sign in
 * because the backend is down should be able to see that from the tab.
 */
export function useBrowserStatus(): void {
  const auth = useAuthStore()
  const agents = useAgentStore()

  const status = computed<ConnectionStatus>(() => {
    if (!backendReachable.value) return 'offline'
    // Only meaningful once there is a session to stream to; a signed-out tab has no stream by design.
    if (auth.can('fleet.read') && !agents.liveUpdatesConnected) return 'stale'
    return 'ok'
  })

  const frames = computed(() =>
    titleFrames({
      reachable: backendReachable.value,
      hasFleet: auth.can('fleet.read'),
      online: agents.online.length,
      total: agents.agents.length,
      percent: Math.round(agents.progressPercent),
      etaMinutes: agents.etaMinutes,
    }),
  )

  const frame = ref(0)

  // Rotating rather than cramming everything into one line: a tab shows about twenty characters
  // before the browser truncates it, and four short facts in turn beat one that is cut off.
  const timer = window.setInterval(() => (frame.value += 1), ROTATE_MS)

  watch(
    [frames, frame],
    ([current, index]) => {
      document.title = current[index % current.length] ?? t('title.plain')
    },
    { immediate: true },
  )

  watch(status, paint, { immediate: true })

  onBeforeUnmount(() => window.clearInterval(timer))
}

const ROTATE_MS = 5000

let logoSource: Promise<string> | null = null

async function paint(status: ConnectionStatus): Promise<void> {
  // Fetched once and reused: the file is the source of the mark, so the dot never drifts from it.
  logoSource ??= fetch(LOGO).then((response) => response.text())

  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
    if (!link) return
    link.type = 'image/svg+xml'
    link.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(await logoSource, status))}`
  } catch {
    // The tab keeps whatever icon it already has. A favicon is not worth a visible failure, and the
    // sidebar says the same thing in words.
    logoSource = null
  }
}

const LOGO = '/logo.svg'
