/**
 * Flattening a Minecraft chat component into styled runs.
 *
 * The host resolves the server's translation keys and strips everything interactive before any of
 * this reaches a browser, so what arrives is a plain tree of text, colour and the five vanilla
 * styles. This turns that tree into a list, which is all a renderer needs.
 *
 * **Everything here treats the tree as hostile.** It was written by whoever runs a Minecraft server.
 * A colour is re-validated even though the host validated it, because this is the last point before
 * it becomes part of a document — and a value that ends up in a style attribute is worth checking on
 * both sides of the wire.
 */

/** A stretch of text sharing one style. */
export interface Run {
  text: string
  /** A CSS colour this module produced, never a string the server chose. */
  color?: string
  bold: boolean
  italic: boolean
  underlined: boolean
  strikethrough: boolean
  obfuscated: boolean
}

/**
 * Minecraft's sixteen, by their canonical hex.
 *
 * `black` and `white` are deliberately missing. They are the two that vanish when the viewer's theme
 * happens to be the same colour, and an unreadable line is worse than a slightly wrong one — so both
 * fall through to whatever the page is already using for text.
 */
const COLOURS: Record<string, string> = {
  dark_blue: '#0000aa',
  dark_green: '#00aa00',
  dark_aqua: '#00aaaa',
  dark_red: '#aa0000',
  dark_purple: '#aa00aa',
  gold: '#ffaa00',
  gray: '#aaaaaa',
  dark_gray: '#555555',
  blue: '#5555ff',
  green: '#55ff55',
  aqua: '#55ffff',
  red: '#ff5555',
  light_purple: '#ff55ff',
  yellow: '#ffff55',
}

const HEX = /^#[0-9a-f]{6}$/i

/** As many runs as the host is allowed to send nodes. A tree past this is cut rather than drawn. */
const MAX_RUNS = 256

interface Node {
  text?: unknown
  color?: unknown
  bold?: unknown
  italic?: unknown
  underlined?: unknown
  strikethrough?: unknown
  obfuscated?: unknown
  extra?: unknown
}

/** The runs of a component tree, or an empty list when there is nothing to draw - which is the
 * caller's signal to fall back to the plain text that always accompanies it. */
export function runsOf(components: unknown): Run[] {
  if (!components || typeof components !== 'object') return []

  const runs: Run[] = []
  walk(components as Node, runs)

  return runs
}

/**
 * Walks the tree, reading each node's own style.
 *
 * **Nothing is inherited here.** Minecraft's real rules are subtle - a child inherits what it does
 * not mention, an explicit `false` is a reset rather than silence, and a colour code clears the
 * styles alongside it - and the host resolves all of that before sending, stamping every node with
 * the style it ends up with. Doing it a second time in a browser would be a second chance to get it
 * wrong, against a tree that has already been decided.
 */
function walk(node: Node, out: Run[]): void {
  if (out.length >= MAX_RUNS) return

  if (typeof node.text === 'string' && node.text !== '') {
    const own = colour(node.color)

    out.push({
      ...(own ? { color: own } : {}),
      bold: node.bold === true,
      italic: node.italic === true,
      underlined: node.underlined === true,
      strikethrough: node.strikethrough === true,
      obfuscated: node.obfuscated === true,
      text: node.text,
    })
  }

  if (!Array.isArray(node.extra)) return

  for (const child of node.extra) {
    if (child && typeof child === 'object') walk(child as Node, out)
  }
}

/** A colour this is willing to put in a style attribute, or nothing at all. */
function colour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const named = COLOURS[value]
  if (named) return named

  return HEX.test(value) ? value.toLowerCase() : undefined
}
