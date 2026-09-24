import { WebSocket } from 'ws'

import { log, reason } from '../log.ts'
import { deserialize } from '../protocol/deserialize.ts'
import type { Bytes } from '../agent/traffic.ts'
import type { Usage } from '../usage.ts'
import type { Command, Outbound } from '../protocol/message.ts'
import { serialize } from '../protocol/serialize.ts'

/** How often the backend is told this host is alive. It derives every agent here as `STALE` after
 * thirty seconds of silence, so this leaves room for two to go missing. */
const HEARTBEAT = 10_000

/** Reconnect backoff. Doubles from the first to the second, which is far enough apart that a
 * rejected token is not retried in a tight loop and close enough that a dropped network is picked
 * back up in about the time it takes to notice. */
const BACKOFF_MIN = 1_000
const BACKOFF_MAX = 60_000

export interface SocketHandlers {
  /** A socket is up and has sent nothing yet. The first frame on any socket is a `handshake`
   * stating what this host is running, and only the dispatcher knows that.
   *
   * Called on every connect rather than only after a restart. A host that kept its sessions across
   * a dropped socket announces them and nothing changes on the backend, which is exactly what makes
   * it safe to send always - and a host cannot reliably tell the two cases apart anyway. */
  connected(): void
  command(command: Command): void
  /** What every agent has moved so far, for the heartbeat. */
  traffic(): Bytes
  /** What this host is costing its machine, for the same heartbeat. */
  usage(): Usage
}

/**
 * The one socket this host has, dialled out and kept up for as long as the process runs.
 *
 * The backend closes any previous connection when we reconnect, so coming back is always safe and
 * is the only recovery there is.
 */
export class HostSocket {
  private socket: WebSocket | undefined
  private backoff = BACKOFF_MIN
  private beat: NodeJS.Timeout | undefined
  /** Said once per failed connection rather than once per attempt. */
  private complained = false

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly version: string,
    private readonly handlers: SocketHandlers,
  ) {}

  start(): void {
    this.open()
  }

  /**
   * Sends one message, or drops it when there is no socket.
   *
   * **Dropped rather than queued.** Everything this host sends describes the present moment, and a
   * reconnect opens with a `handshake` that restates it - so a backlog delivered on reconnect would
   * be a series of claims about a past the backend has already been told the end of.
   */
  send(message: Outbound): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      log.debug(`Dropping a ${message.kind === 'result' ? 'setup result' : message.body.type} with no socket to send it on`)
      return
    }

    this.socket.send(serialize(message))
  }

  /**
   * Sends one batch of world updates, or drops it when there is no socket.
   *
   * A binary frame, so the backend can tell it from the control protocol without reading either -
   * that one stays JSON, this stays bytes and is relayed untouched. Dropped rather than queued for
   * the same reason as {@link send}, and more so: a stale frame of a world is worse than none.
   */
  stream(frame: Buffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(frame, { binary: true })
  }

  private open(): void {
    // Authentication happens during the handshake, before any frame is accepted, which is why this
    // rides on the upgrade rather than being a first message.
    const socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` } })
    this.socket = socket

    socket.on('open', () => {
      log.info(`Connected to ${this.url}`)
      this.backoff = BACKOFF_MIN
      this.complained = false

      this.beat = setInterval(
        () =>
          this.send({
            kind: 'event',
            body: {
              type: 'heartbeat',
              version: this.version,
              traffic: this.handlers.traffic(),
              usage: this.handlers.usage(),
            },
          }),
        HEARTBEAT,
      )
      this.handlers.connected()
    })

    socket.on('message', (raw) => {
      try {
        this.handlers.command(deserialize(raw.toString()))
      } catch (err) {
        // Logged and dropped, never fatal. A backend newer than this build is expected to say
        // things it has not learned about yet.
        log.debug(`Ignoring frame: ${reason(err)}`)
      }
    })

    socket.on('unexpected-response', (_request, response) => {
      // A rejected token will not start working on its own, so it is said loudly rather than buried
      // under a retry that is never going to succeed.
      if (response.statusCode === 401) {
        log.error('Backend rejected our token. Check OSMIUM_HOST_TOKEN.')
        this.complained = true
      }
    })

    socket.on('error', (err) => {
      if (!this.complained) log.error(`Failed to reach backend at ${this.url}: ${reason(err)}`)
      this.complained = true
    })

    socket.on('close', () => this.closed())
  }

  private closed(): void {
    clearInterval(this.beat)
    this.beat = undefined
    this.socket = undefined

    log.warn(`Socket closed, reconnecting in ${this.backoff / 1000}s`)
    setTimeout(() => this.open(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
  }
}
