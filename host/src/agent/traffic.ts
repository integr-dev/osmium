/**
 * Bytes an agent has moved to and from its Minecraft server.
 *
 * Read off the session's socket, which Node already counts, rather than by listening to packets:
 * a packet listener sees what was decoded, and the operator is asking what went over the wire -
 * compression and encryption included.
 */
export interface Bytes {
  sent: number
  received: number
}

/** The part of a `net.Socket` this reads. A socks proxy hands back the same kind of socket. */
export interface Counted {
  bytesRead?: number
  bytesWritten?: number
}

export const NO_BYTES: Bytes = { sent: 0, received: 0 }

export function add(a: Bytes, b: Bytes): Bytes {
  return { sent: a.sent + b.sent, received: a.received + b.received }
}

/** The socket under a bot, when it has one yet. It is only attached once the connection opens. */
export function socketOf(bot: unknown): Counted | undefined {
  return (bot as { _client?: { socket?: Counted } } | undefined)?._client?.socket
}

/**
 * Running totals across every session an agent has had.
 *
 * A socket's counters die with it, so each session's are folded in as it ends. The backend turns
 * two totals into a rate, which is why these only ever grow while the host runs.
 */
export class Traffic {
  private ended: Bytes = NO_BYTES

  /** Everything so far, including the session still open on [live]. */
  total(live: Counted | undefined): Bytes {
    return add(this.ended, bytesOf(live))
  }

  /** A session is over: keep what its socket moved. */
  retire(live: Counted | undefined): void {
    this.ended = this.total(live)
  }
}

function bytesOf(socket: Counted | undefined): Bytes {
  return { sent: socket?.bytesWritten ?? 0, received: socket?.bytesRead ?? 0 }
}
