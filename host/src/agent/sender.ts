import { log } from '../log.ts'

/**
 * Working out who said a line.
 *
 * **A host cannot know this from the protocol.** Modern servers send chat as one rendered line - the
 * formatter's work, prefix and colours and all - with nothing marking which part is the speaker. The
 * player who typed it is in there, but only as text.
 *
 * So it is read back out with a pattern. Vanilla's `<Name> message` is the default because it is
 * what an unmodified server sends; a server with its own format needs its own pattern, which is
 * configuration rather than something a host can work out - see `chat.sender` in §3.
 *
 * **Nothing is guessed.** A line the pattern does not match is reported as coming from the server,
 * which is honest - it is a line this host cannot attribute - and is the one thing it must not do
 * instead: name the agent that happened to be listening. Every agent on a server sees the same room,
 * so attributing the room to whichever agent overheard it turns a server's small talk into that
 * agent's conversation.
 */

/** What a line is attributed to when no player can be read out of it.
 *
 * Server messages, join and leave notices, command output, and anything a formatter dressed up past
 * recognition. */
export const SERVER = 'server'

/**
 * Vanilla's chat format.
 *
 * The name rules are Mojang's: letters, digits and underscore, up to sixteen. Deliberately anchored
 * to the start, so a player quoting `<Notch> hi` inside their own message cannot be read as Notch
 * saying it.
 */
export const VANILLA = /^<([A-Za-z0-9_]{1,16})>\s/

/**
 * Vanilla's incoming whisper, as it reads once its translation key is resolved.
 *
 * A whisper is chat addressed to this agent rather than to the room, which is the whole reason the
 * distinction is worth drawing: an agent's own conversation is the handful of lines actually about
 * it, and the room's small talk buries them.
 *
 * Only the incoming direction. What this agent whispers *out* it already knows it said.
 */
export const WHISPER = /^([A-Za-z0-9_]{1,16}) whispers to you:\s/

/**
 * Vanilla's outgoing whisper — one this agent sent.
 *
 * Its own pattern rather than a direction flag on {@link WHISPER}, because a server writes the two
 * differently and only the server knows how. What it captures is the **recipient**, which is the
 * only name in the line; the speaker is the agent, and needs no reading.
 *
 * Without this a whisper an operator sent comes back unattributable and is filed as the server
 * talking — the one line in the feed they know for certain was theirs.
 */
export const WHISPER_SENT = /^You whisper to ([A-Za-z0-9_]{1,16}):\s/

/**
 * Compiles a configured pattern, or nothing when it cannot be used.
 *
 * **Refused rather than accepted blindly**, for two reasons an operator would rather find out about
 * here than by watching chat go unattributed: a pattern that does not compile, and one that compiles
 * but captures nothing, which can name nobody however well it matches.
 */
export function compile(source: string | undefined, why: string): RegExp | undefined {
  if (!source) return undefined

  try {
    const pattern = new RegExp(source)

    if (!pattern.source.includes('(')) {
      log.warn(`${why} has no capture group, so it can name nobody: ${source}`)
      return undefined
    }

    return pattern
  } catch (err) {
    log.warn(`${why} is not a usable pattern (${reason(err)}): ${source}`)
    return undefined
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Who said a line, or {@link SERVER} when it cannot be told.
 *
 * The capture is the name. A pattern with several groups uses the first that matched, so a format
 * needing a group around the rank can put one there without having to think about ordering.
 */
export function senderOf(text: string, pattern: RegExp = VANILLA): string {
  const found = pattern.exec(text)?.slice(1).find((group) => group !== undefined)

  return found && usable(found) ? found : SERVER
}

/** Mojang's rules, applied to whatever the pattern captured. A pattern written for a server that
 * decorates its names must capture the name, not the decoration. */
function usable(name: string): boolean {
  return name.length > 0 && name.length <= 16 && /^[A-Za-z0-9_]+$/.test(name)
}
