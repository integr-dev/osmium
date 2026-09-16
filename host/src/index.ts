import { readNbtStringsProperly } from './agent/nbt.ts'
import { log, reason } from './log.ts'
import { Dispatcher } from './router/dispatch.ts'
import { HostSocket } from './socket/client.ts'
import { Proxies, proxiesPath } from './agent/proxy.ts'
import { accountsPath, cachePath } from './token/paths.ts'
import { AccountStore } from './token/store.ts'
import { VERSION } from './version.ts'

async function main(): Promise<void> {
  // Before any session opens: it corrects how every NBT string on the wire is decoded.
  readNbtStringsProperly()

  const token = required('OSMIUM_HOST_TOKEN')
  const url = required('OSMIUM_WS_URL')

  const accounts = accountsPath()
  const cache = cachePath()

  // Opened before the socket, so a store that cannot be read is discovered now rather than after
  // the backend has been told this host is up and ready to be given agents.
  const store = await AccountStore.open(accounts)
  log.info(`Reading accounts from ${accounts}`)

  // Read here for the same reason the accounts are: a file this host cannot make sense of should be
  // discovered before the backend is told the host is up, not while an agent is trying to connect.
  const proxies = await Proxies.open(proxiesPath())

  const socket = new HostSocket(url, token, VERSION, {
    connected: () => dispatcher.announce(),
    command: (command) => dispatcher.command(command),
    traffic: () => dispatcher.traffic(),
  })

  const dispatcher = new Dispatcher(
    store,
    cache,
    proxies,
    (message) => socket.send(message),
    (frame) => socket.stream(frame),
  )

  dispatcher.restore()
  socket.start()
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    log.error(`set env ${name}`)
    process.exit(1)
  }

  return value
}

main().catch((err) => {
  log.error(`Host could not start: ${reason(err)}`)
  process.exit(1)
})
