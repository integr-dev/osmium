/**
 * Colouring a regular expression, so an operator can see its shape rather than a wall of symbols.
 *
 * A pattern for reading names out of chat is mostly punctuation — `^\[[^\]]+\]\s+([A-Za-z0-9_]{1,16}):\s`
 * says something clear once the group, the class and the quantifier are told apart, and says nothing
 * at all as one run of grey text. The part an operator has to find is the **capture group**: it is
 * what names the player, and a pattern without one can match perfectly and still name nobody.
 *
 * Not a parser. It classifies each character well enough to colour it, and a construct it does not
 * recognise falls through as a literal rather than throwing — the box has to keep working while
 * something half-typed is in it.
 */

export type TokenKind =
  /** `(` `)` `|` — the structure, and where a capture is. */
  | 'group'
  /** `[abc]` `[^x]` — a set of characters. */
  | 'class'
  /** `\d` `\.` — an escape, whether a class shorthand or a literal. */
  | 'escape'
  /** `*` `+` `?` `{1,16}` — how many. */
  | 'quantifier'
  /** `^` `$` `\b` — a position rather than a character. */
  | 'anchor'
  /** Everything that just matches itself. */
  | 'literal'

export interface Token {
  text: string
  kind: TokenKind
}

/** Splits a pattern into coloured runs, in order, losing nothing: joining every `text` gives the
 * pattern back exactly. That is what lets the highlighting sit behind a real input. */
export function tokenize(pattern: string): Token[] {
  // Nothing here may throw: it runs on every keystroke, inside a render, against whatever a caller
  // has bound to it — which is nothing at all the moment a field exists before its value does.
  if (typeof pattern !== 'string' || pattern === '') return []

  const tokens: Token[] = []
  let at = 0

  const push = (text: string, kind: TokenKind) => {
    // Runs of the same kind are merged, so a word of literals is one span rather than one per
    // letter. A chat pattern is mostly literals and this is most of the elements on the page.
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push({ text, kind })
  }

  while (at < pattern.length) {
    const char = pattern[at]!

    if (char === '\\') {
      // The escape and whatever it escapes, together. A trailing backslash is somebody mid-keystroke
      // rather than an error to complain about.
      const escaped = pattern.slice(at, at + 2)
      push(escaped, /^\\[bB]$/.test(escaped) ? 'anchor' : 'escape')
      at += escaped.length
      continue
    }

    if (char === '[') {
      const end = closingClass(pattern, at)
      push(pattern.slice(at, end), 'class')
      at = end
      continue
    }

    if (char === '{') {
      const end = pattern.indexOf('}', at)
      // Only a quantifier when it closes and holds digits. `{` is a literal brace otherwise, which
      // is exactly what a half-typed one is.
      if (end !== -1 && /^\{\d+(,\d*)?\}$/.test(pattern.slice(at, end + 1))) {
        push(pattern.slice(at, end + 1), 'quantifier')
        at = end + 1
        continue
      }
    }

    if (char === '(' || char === ')' || char === '|') {
      push(char, 'group')
      at += 1
      continue
    }

    if (char === '*' || char === '+' || char === '?') {
      push(char, 'quantifier')
      at += 1
      continue
    }

    if (char === '^' || char === '$') {
      push(char, 'anchor')
      at += 1
      continue
    }

    push(char, 'literal')
    at += 1
  }

  return tokens
}

/** Where a character class ends, allowing for `]` as its first member and for escapes inside it. An
 * unclosed one runs to the end, which is what a half-typed class is. */
function closingClass(pattern: string, start: number): number {
  let at = start + 1
  if (pattern[at] === '^') at += 1
  // `[]]` is a class containing `]`, so the first one never closes it.
  if (pattern[at] === ']') at += 1

  while (at < pattern.length) {
    if (pattern[at] === '\\') at += 2
    else if (pattern[at] === ']') return at + 1
    else at += 1
  }

  return pattern.length
}

/** What a pattern is wrong about, or nothing when it is usable.
 *
 * Two failures, and the second is the one worth catching: a pattern with no capture group compiles,
 * matches, and can never name anybody — which looks like the host ignoring it. */
export function faultIn(pattern: string): 'invalid' | 'nocapture' | undefined {
  if (typeof pattern !== 'string' || !pattern) return undefined

  try {
    new RegExp(pattern)
  } catch {
    return 'invalid'
  }

  // A group that is not a capture — `(?:…)`, a lookahead — does not count, since none of them
  // produce a name.
  return /\((?!\?)/.test(pattern) ? undefined : 'nocapture'
}

/** What a pattern reads out of a line, for showing an operator whether it does what they meant.
 *
 * The first group that participated, which is the same rule the host applies. */
export function captureFrom(pattern: string, sample: string): string | undefined {
  if (typeof pattern !== 'string' || typeof sample !== 'string') return undefined
  if (faultIn(pattern)) return undefined

  try {
    return new RegExp(pattern).exec(sample)?.slice(1).find((group) => group !== undefined)
  } catch {
    return undefined
  }
}
