/**
 * The two global shortcuts, spelled the way the machine reading them spells them.
 *
 * Showing `Ctrl K` to somebody on a Mac teaches a shortcut that does not work there, which is worse
 * than showing nothing at all. Both halves live here so the label and the handler can never drift
 * into disagreeing about which key it is.
 */
const APPLE = /Mac|iPhone|iPad/

/** What to print next to the thing the shortcut opens. */
export function shortcutLabel(key: string): string {
  return APPLE.test(navigator.userAgent) ? `⌘${key}` : `Ctrl ${key}`
}

/**
 * Accepts either modifier on either platform. A Mac keyboard on a Linux box still sends Ctrl, and
 * refusing it would strand the operator with a shortcut the interface is advertising.
 */
export function isShortcut(event: KeyboardEvent, key: string): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === key.toLowerCase()
}
