/**
 * The login mechanisms this host advertises.
 *
 * The ids are wire values. Once a host has advertised one, renaming it breaks setups the operator
 * has already been offered - the backend hands the chosen id straight back as `setup_agent`'s
 * `method` without interpreting or storing it.
 */

/** Note what is *not* a credential kind: `device_code`. That is a mechanism for obtaining one, not
 * one of them - it is performed, and what it leaves behind is a stored Microsoft account like any
 * other. */
export const LoginKind = {
  DeviceCode: 'device_code',
  RefreshToken: 'refresh_token',
  MojangToken: 'mojang_token',
  NoToken: 'no_token',
} as const

export type LoginKind = (typeof LoginKind)[keyof typeof LoginKind]

/** The kinds that name something the store can hold. */
export type StoredKind = typeof LoginKind.RefreshToken | typeof LoginKind.MojangToken | typeof LoginKind.NoToken

const KINDS: readonly LoginKind[] = Object.values(LoginKind)

/** The kind an incoming `method` names, or `undefined` for one this host never advertised.
 *
 * The backend checks the string against our own list before sending, so this failing is the race
 * where the list changed in between rather than the ordinary case. */
export function kindFromId(id: string): LoginKind | undefined {
  return KINDS.find((kind) => kind === id)
}

/** Whether choosing this asks the operator to do something before the agent can be set up.
 *
 * The store cannot answer for these: there is nothing in it to hand out, because performing the
 * mechanism is what creates the credential. */
export function isInteractive(kind: LoginKind): boolean {
  return kind === LoginKind.DeviceCode
}

/** One entry of the handshake's `loginMethods`: a mechanism this machine can perform.
 *
 * A mechanism, never an account: "Sign in with Microsoft" describes a flow, and naming an identity
 * here would hand the backend the one thing this design keeps out of it. */
export interface LoginMethod {
  id: string
  label: string
  description: string
}

/** What this host advertises on connect.
 *
 * Everything it can perform, whether or not a credential of that kind is currently loaded: running
 * out of accounts is an ordinary `ok: false` on the setup, whereas a method left off this list can
 * never be chosen at all.
 *
 * Device code leads because it is the only one that works on a host nobody has put files on - the
 * rest need a credential already sitting in the token store. */
export function advertised(): LoginMethod[] {
  return [
    {
      id: LoginKind.DeviceCode,
      label: 'Sign in with Microsoft',
      description:
        "Approve a code at microsoft.com/link - it appears in this agent's activity feed. The account is then kept on the host, so nothing has to be signed in again after a restart. Start here if the host has no accounts on it yet.",
    },
    {
      id: LoginKind.RefreshToken,
      label: 'Stored Microsoft account',
      description:
        'Reuses a Microsoft account this host already holds. Accounts get there by signing in with Microsoft once, or by running osmium-link on the host. Each account serves one agent, so this fails when they are all spoken for.',
    },
    {
      id: LoginKind.MojangToken,
      label: 'Stored Minecraft token',
      description:
        "Uses a Minecraft session token written into the host's token file by hand. Nothing here can obtain one, and it cannot be renewed - expect it to stop working after about a day.",
    },
    {
      id: LoginKind.NoToken,
      label: 'Offline',
      description:
        'Joins with a generated name and needs no account at all. Only works on servers running with online-mode disabled. The name is kept, so it survives a restart.',
    },
  ]
}
