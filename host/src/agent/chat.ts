/**
 * Turning a Minecraft chat component into something safe to send and simple to draw.
 *
 * **Why this exists at all.** What arrives from a server is a tree - coloured runs, nested styling,
 * and translation keys standing in for whole sentences. Flattening it to a string, which is what
 * this host did first, throws away everything that makes a server's chat legible: who is staff, what
 * is a whisper, which half of the line is the message.
 *
 * Four things happen here, and each of them has to happen on this side.
 *
 * **Translations are resolved.** Most of what a server says is not literal text but a key -
 * `multiplayer.player.joined`, `chat.type.text` - filled in from the language file for the version
 * the agent negotiated. Only the host knows that version and has that file. Sending keys onward
 * would put a 470KB table in every browser, per version, to say "Notch joined the game".
 *
 * **Legacy section codes are parsed.** Plenty of servers still put `§c§lLIKE THIS` inside a text
 * node rather than using the component fields. Left alone those reach a browser as literal `§c`,
 * and the styling they describe - including obfuscated text - is never applied at all.
 *
 * **Styling is resolved, not inherited.** Every node that leaves here states its own style in full.
 * Minecraft's rules are subtle - a child inherits what it does not mention, and an explicit `false`
 * or a null colour is a *reset* rather than silence - and getting them wrong is how a rank prefix
 * ends up colouring an entire line. Deciding it once, here, means nothing downstream can.
 *
 * **Everything interactive is dropped.** `clickEvent`, `hoverEvent`, `insertion` and `font` never
 * leave here. This is text written by whoever runs a Minecraft server, rendered in an operator's
 * console, and a link that server chose is not something an operator should be one click from.
 */

/** One node of the tree that reaches the backend.
 *
 * Deliberately a small, closed set: text, the five vanilla styles, a colour, and children. Anything
 * a future Minecraft adds is dropped rather than passed through, because whatever draws this cannot
 * be asked to understand something nobody has written yet.
 *
 * Every style here is **absolute**. An absent field means off, never "ask my parent". */
export interface Component {
  text: string
  /** A vanilla colour name, or `#rrggbb`. Never anything else - see {@link colour}. */
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
  extra?: Component[]
}

/** The sixteen names Minecraft uses. Anything outside this and a plain hex triple is discarded, so
 * that whatever renders this can never be handed a value it has to sanitise itself. */
const COLOURS = new Set([
  'black',
  'dark_blue',
  'dark_green',
  'dark_aqua',
  'dark_red',
  'dark_purple',
  'gold',
  'gray',
  'dark_gray',
  'blue',
  'green',
  'aqua',
  'red',
  'light_purple',
  'yellow',
  'white',
])

/** The legacy `§` alphabet: colour digits, five styles, and reset. What a server writes inline when
 * it is not using the component fields. */
const LEGACY_COLOURS: Record<string, string> = {
  '0': 'black',
  '1': 'dark_blue',
  '2': 'dark_green',
  '3': 'dark_aqua',
  '4': 'dark_red',
  '5': 'dark_purple',
  '6': 'gold',
  '7': 'gray',
  '8': 'dark_gray',
  '9': 'blue',
  a: 'green',
  b: 'aqua',
  c: 'red',
  d: 'light_purple',
  e: 'yellow',
  f: 'white',
}

const LEGACY_STYLES: Record<string, keyof Style> = {
  k: 'obfuscated',
  l: 'bold',
  m: 'strikethrough',
  n: 'underlined',
  o: 'italic',
}

const SECTION = '§'
const HEX = /^#[0-9a-fA-F]{6}$/

/** Caps. A chat line is written by a stranger, so every one of these is a bound on what a hostile
 * server can make this host send and a browser draw. */
const MAX_NODES = 256
const MAX_DEPTH = 16
const MAX_TEXT = 4096

/** What prismarine-chat hands us. Described here rather than imported because its published types
 * do not include the parsed fields, only the class. */
interface Message {
  text?: unknown
  translate?: unknown
  with?: unknown
  extra?: unknown
  color?: unknown
  bold?: unknown
  italic?: unknown
  underlined?: unknown
  strikethrough?: unknown
  obfuscated?: unknown
}

/** The style in force at some point in the tree. Every field decided; nothing left to inherit. */
interface Style {
  color?: string
  bold: boolean
  italic: boolean
  underlined: boolean
  strikethrough: boolean
  obfuscated: boolean
}

const PLAIN: Style = { bold: false, italic: false, underlined: false, strikethrough: false, obfuscated: false }

/**
 * Resolves one chat message into a component tree, or `undefined` when there is nothing worth
 * sending.
 *
 * `language` is the table for the version the agent is connected on - `minecraft-data`'s `language`
 * map. A key it does not hold falls back to the key itself, which is ugly but honest and is what a
 * vanilla client shows too.
 */
export function componentsOf(message: unknown, language: Record<string, string>): Component | undefined {
  if (!message || typeof message !== 'object') return undefined

  const budget = { nodes: MAX_NODES, text: MAX_TEXT }
  const parts = walk(message as Message, language, { ...PLAIN }, budget, 0)

  if (!parts.length) return undefined

  // A single node needs no wrapper; anything else hangs off an empty root, which is the shape
  // Minecraft itself uses.
  return parts.length === 1 ? parts[0] : { text: '', extra: parts }
}

/**
 * Walks one node, returning the components it produces.
 *
 * A list rather than a single node, because one node can become several: a text run carrying `§`
 * codes is several styled pieces, and a translation is its pattern interleaved with its arguments.
 */
function walk(
  node: Message,
  language: Record<string, string>,
  inherited: Style,
  budget: Budget,
  depth: number,
): Component[] {
  if (depth > MAX_DEPTH || budget.nodes <= 0) return []

  const style = restyle(node, inherited)
  const parts: Component[] = []

  if (typeof node.translate === 'string') {
    const args = Array.isArray(node.with) ? (node.with as Message[]) : []
    parts.push(...translate(node.translate, args, language, style, budget, depth))
  } else if (typeof node.text === 'string' && node.text !== '') {
    parts.push(...runs(node.text, style, budget))
  }

  if (Array.isArray(node.extra)) {
    for (const child of node.extra) {
      // The children inherit this node's style, which is the whole reason it is threaded through.
      if (child && typeof child === 'object') parts.push(...walk(child as Message, language, style, budget, depth + 1))
    }
  }

  budget.nodes -= parts.length

  return parts
}

interface Budget {
  nodes: number
  text: number
}

/**
 * The style in force for a node, given what it inherited.
 *
 * Minecraft's three cases, kept apart: a field a node does not mention is inherited, `true` turns it
 * on, and **`false` turns it off** - which is what `§r` becomes and what a component uses to stop a
 * parent's bold. Treating `false` as silence, which is the easy mistake, means a reset never resets.
 * A null colour is the same idea for colour.
 */
function restyle(node: Message, inherited: Style): Style {
  const style: Style = { ...inherited }

  if (node.color === null) delete style.color
  else {
    const shade = colour(node.color)
    if (shade) style.color = shade
  }

  for (const name of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const) {
    const set = flag(node[name])
    if (set !== undefined) style[name] = set
  }

  return style
}

/**
 * Reads a style flag, which is not always a boolean.
 *
 * **NBT has no boolean type.** Chat components have travelled as NBT rather than JSON since 1.20.3,
 * and a flag that reads `true` in a JSON component arrives over the wire as `TAG_Byte` 1. Insisting
 * on an actual boolean therefore dropped every style a modern server sent - most visibly obfuscated
 * text, which has no other way of being expressed.
 *
 * `undefined` means the node did not mention it, which is what tells a child to inherit; `false` and
 * `0` are a reset and are not the same thing.
 */
function flag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1) return true
  if (value === 0) return false

  return undefined
}

/**
 * Splits a text run on its `§` codes.
 *
 * A code applies from where it appears until the next one; `§r` returns to the style the run started
 * with, rather than to nothing, because the codes sit inside a component that has its own styling to
 * fall back to. A `§` at the very end, or before something that is not a code, is kept as text - it
 * is a character a player is allowed to type.
 */
function runs(text: string, style: Style, budget: Budget): Component[] {
  if (!text.includes(SECTION)) return [component(take(text, budget), style)]

  const parts: Component[] = []
  let current: Style = { ...style }
  let literal = ''

  const flush = () => {
    if (!literal) return
    parts.push(component(take(literal, budget), current))
    literal = ''
  }

  for (let at = 0; at < text.length; at++) {
    if (text[at] !== SECTION || at + 1 >= text.length) {
      literal += text[at]
      continue
    }

    const code = text[at + 1]!.toLowerCase()
    const shade = LEGACY_COLOURS[code]
    const toggle = LEGACY_STYLES[code]

    if (!shade && !toggle && code !== 'r') {
      // Not a code at all. Kept, because it is a character somebody typed.
      literal += text[at]
      continue
    }

    flush()
    at++

    if (code === 'r') current = { ...style }
    // A colour resets the styles with it, as it does in game.
    else if (shade) current = { ...PLAIN, color: shade }
    else if (toggle) current = { ...current, [toggle]: true }
  }

  flush()

  return parts.filter((part) => part.text !== '')
}

/**
 * Fills a translation pattern with its arguments.
 *
 * Minecraft's patterns are `printf`-flavoured: `%s` takes the next argument, `%1$s` takes a numbered
 * one, and `%%` is a literal percent. Everything between them is literal text carrying the sentence's
 * own style, while each argument keeps whatever style it brought - so a yellow name stays yellow
 * inside a grey sentence.
 */
function translate(
  key: string,
  args: Message[],
  language: Record<string, string>,
  style: Style,
  budget: Budget,
  depth: number,
): Component[] {
  const pattern = language[key] ?? key
  const parts: Component[] = []

  let literal = ''
  let next = 0

  const flush = () => {
    if (!literal) return
    parts.push(...runs(literal, style, budget))
    literal = ''
  }

  for (let at = 0; at < pattern.length; at++) {
    if (pattern[at] !== '%') {
      literal += pattern[at]
      continue
    }

    const after = pattern[at + 1]

    if (after === '%') {
      literal += '%'
      at++
      continue
    }

    // `%1$s`, one-based, as Minecraft numbers them.
    const numbered = /^(\d+)\$s/.exec(pattern.slice(at + 1))
    let index: number

    if (numbered) {
      index = Number(numbered[1]) - 1
      at += numbered[0].length
    } else if (after === 's') {
      index = next++
      at++
    } else {
      literal += '%'
      continue
    }

    flush()

    const argument = args[index]
    if (argument && typeof argument === 'object') parts.push(...walk(argument, language, style, budget, depth + 1))
  }

  flush()

  return parts
}

/** A node with its style stamped on, omitting everything that is off so the wire stays small. */
function component(text: string, style: Style): Component {
  const node: Component = { text }

  if (style.color) node.color = style.color
  if (style.bold) node.bold = true
  if (style.italic) node.italic = true
  if (style.underlined) node.underlined = true
  if (style.strikethrough) node.strikethrough = true
  if (style.obfuscated) node.obfuscated = true

  return node
}

/** A colour, or nothing.
 *
 * Validated here rather than wherever it is drawn, because this is the point at which a value
 * written by a stranger becomes part of a document. */
function colour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (COLOURS.has(value)) return value

  return HEX.test(value) ? value.toLowerCase() : undefined
}

/**
 * Takes text up to the budget, so a long line is cut rather than refused.
 *
 * **Cut on characters, not on UTF-16 units.** A JavaScript string is stored as pairs, and slicing at
 * an arbitrary index can land in the middle of one - leaving half of an emoji, which is not a
 * character at all and renders as a replacement glyph everywhere it is shown. Splitting by code
 * point and re-joining keeps every character whole, and keeps the budget honest about how much text
 * a reader actually gets. Combining marks and joined emoji sequences can still be divided; that is
 * cosmetic, where a lone surrogate is malformed.
 */
function take(text: string, budget: Budget): string {
  if (budget.text <= 0) return ''

  const characters = [...text]
  if (characters.length <= budget.text) {
    budget.text -= characters.length
    return text
  }

  const kept = characters.slice(0, budget.text).join('')
  budget.text = 0

  return kept
}
