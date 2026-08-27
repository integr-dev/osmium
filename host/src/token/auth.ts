import { createHash, randomUUID } from 'node:crypto'

// Destructured from the default import rather than named: prismarine-auth is CommonJS, and Node
// cannot detect named exports through the indirection its entry point uses - so `import { Authflow }`
// throws at load rather than failing to type-check.
import prismarineAuth from 'prismarine-auth'

const { Authflow, Titles } = prismarineAuth

import { LoginKind } from './login.ts'
import type { Entry } from './store.ts'

/**
 * Turning a stored credential into an identity, and acquiring one that is not stored yet.
 *
 * **Nothing here ever sees a password.** Microsoft sign-ins happen in the operator's own browser,
 * on whatever machine they like; this host holds a code that is worthless without their approval.
 * That is the same rule `setup_agent` follows in relaying a mechanism and never an account.
 */

/** Who an account turns out to be. Never a credential. */
export interface Identity {
  username: string
  uuid: string
}

/** A sign-in waiting on a person. */
export interface LinkCode {
  /** Where the operator goes. */
  url: string
  /** What they type when they get there. */
  code: string
  /** How long they have, in seconds. */
  expiresIn: number
}

/**
 * The title the token cache is filed under.
 *
 * Matched to what node-minecraft-protocol defaults to, deliberately: the bot signs in through nmp
 * using the same cache directory, so a mismatch here would leave it looking for tokens under a
 * title nothing had written.
 */
const FLOW = { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' } as const

/** A credential that was never signed in, or whose cache has been lost.
 *
 * Thrown from where a sign-in would otherwise be started: the caller is resolving an account it was
 * told it already had, and a device code appearing at that point would be asking somebody who is
 * not there. */
export class NotSignedIn extends Error {}

/**
 * Signs in to Microsoft, and keeps what that yields.
 *
 * `show` is handed the code the moment Microsoft issues one, before anything waits on it - only the
 * caller knows how to reach a person, and a code delivered after the wait would be useless.
 *
 * The account is filed under a name of our own rather than under whoever it turns out to be,
 * because that is not known until the sign-in has already happened.
 */
export async function signIn(directory: string, show: (code: LinkCode) => void): Promise<{ cache: string } & Identity> {
  const cache = randomUUID()

  const flow = new Authflow(cache, directory, FLOW, (response) =>
    show({ url: response.verification_uri, code: response.user_code, expiresIn: response.expires_in }),
  )

  const { profile } = await flow.getMinecraftJavaToken({ fetchProfile: true })
  if (!profile?.id) throw new Error('signed in, but that account does not own Minecraft')

  return { cache, ...named(profile) }
}

/**
 * Who a stored credential belongs to.
 *
 * Proven rather than assumed. A credential that cannot reach a Minecraft profile is worth finding
 * out about while an operator is watching a setup, rather than the first time somebody presses
 * Connect and gets a failure with nothing to point at.
 */
export async function identify(entry: Entry, directory: string): Promise<Identity> {
  switch (entry.kind) {
    case LoginKind.RefreshToken: {
      if (!entry.cache) throw new NotSignedIn('this account has no sign-in on this host')

      const flow = new Authflow(entry.cache, directory, FLOW, () => {
        throw new NotSignedIn('this account is no longer signed in')
      })

      const { profile } = await flow.getMinecraftJavaToken({ fetchProfile: true })
      if (!profile?.id) throw new Error('that account does not own Minecraft')

      return named(profile)
    }

    case LoginKind.MojangToken: {
      if (!entry.token) throw new Error('this entry has no session token')
      return named(await profileOf(entry.token))
    }

    case LoginKind.NoToken: {
      // Made up here and kept in the store, so a restored offline agent rejoins under the name it
      // had. The uuid is the one an offline server derives from that name.
      const username = entry.username ?? 'Osmium'
      return { username, uuid: offlineUuid(username) }
    }
  }
}

/** The Minecraft profile a session token belongs to. */
async function profileOf(token: string): Promise<{ id: string; name: string }> {
  const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) throw new Error(`the session token was refused (${response.status})`)

  return (await response.json()) as { id: string; name: string }
}

/** Mojang writes uuids without dashes; everything that reads them here expects dashes. */
function named(profile: { id: string; name: string }): Identity {
  return { username: profile.name, uuid: dashed(profile.id) }
}

function dashed(id: string): string {
  if (id.includes('-')) return id
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

/**
 * The uuid an offline server gives a name.
 *
 * A version 3 uuid over `OfflinePlayer:<name>`, which is what vanilla does - so the agent Osmium
 * names is the one the server's own logs and permissions files name.
 */
export function offlineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`).digest()

  hash[6] = (hash[6]! & 0x0f) | 0x30
  hash[8] = (hash[8]! & 0x3f) | 0x80

  return dashed(hash.toString('hex'))
}
