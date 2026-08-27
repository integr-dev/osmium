import { api } from '../api/client'
import type { FleetAgent } from '../stores/agents'

/**
 * What an operator can configure about an agent.
 *
 * **Declared here, on purpose.** A host does not advertise these: it applies the keys it recognises
 * and ignores the rest, so a setting exists the moment this list and one host agree on a name. That
 * keeps a new setting to an entry here plus the code that reads it, rather than a release on three
 * sides in order.
 *
 * The backend stores the map and relays it without interpreting anything, exactly as it relays a
 * login `method`. So the only place that knows what `chat.sender` *means* is this file and the host
 * that reads it.
 *
 * `connect.rejoin` is the one exception, and it is the exception for a structural reason rather than
 * a convenient one: putting an agent back into the game is a decision about where an agent belongs,
 * and a host is never allowed to make one of those — it reports, the backend decides. So that key is
 * read by the backend, relayed to the host like every other, and ignored there.
 */

export interface SettingField {
  key: string
  /** Chosen by what the value *is*, so the view never switches on the key itself. */
  type: 'regex' | 'text' | 'switch' | 'choice'
  /** Filled into the box when an operator asks for a starting point, and what the host falls back
   * to when nothing is set. Shown rather than silently applied. */
  default?: string
  /** A line the pattern is expected to match, for showing whether it does. */
  sample?: string
  /** Shown in an empty box. A `text` field has no pattern to fall back on, so this is where the
   * shape of a valid answer is stated. */
  placeholder?: string
  /**
   * For a `choice`, the values it offers. Empty is one of them and is always first: a setting nobody
   * has touched is a real answer, and one that reads "unset" is not the same as one that reads
   * "off". The labels come from i18n, keyed by the field and the value.
   */
  options?: string[]
}

export interface SettingGroup {
  key: string
  fields: SettingField[]
}

/** Everything an operator has set for one agent. Absent keys are unset, not defaulted. */
export type AgentSettings = Record<string, string>

/**
 * Vanilla's chat format, which is what a host uses when nothing is configured.
 *
 * Offered as a starting point rather than applied: a server that needs no pattern needs no setting,
 * and storing the default would make "unset" indistinguishable from "set to the default".
 */
export const VANILLA_SENDER = '^<([A-Za-z0-9_]{1,16})> '

/** Vanilla's incoming whisper, as it reads once the host has resolved its translation key. */
export const VANILLA_WHISPER = '^([A-Za-z0-9_]{1,16}) whispers to you: '

/** Vanilla's outgoing whisper. What it captures is the recipient — the only name in the line, since
 * the speaker is the agent itself. */
export const VANILLA_WHISPER_SENT = '^You whisper to ([A-Za-z0-9_]{1,16}): '

export const SETTING_GROUPS: SettingGroup[] = [
  {
    key: 'chat',
    fields: [
      {
        key: 'chat.sender',
        type: 'regex',
        default: VANILLA_SENDER,
        sample: '<Notch> hello there',
      },
      {
        key: 'chat.whisper',
        type: 'regex',
        default: VANILLA_WHISPER,
        sample: 'Notch whispers to you: are you there',
      },
      {
        key: 'chat.whisperSent',
        type: 'regex',
        default: VANILLA_WHISPER_SENT,
        sample: 'You whisper to Notch: on my way',
      },
    ],
  },
  {
    key: 'mc',
    fields: [
      {
        key: 'mc.version',
        type: 'text',
        placeholder: '1.21.4',
      },
      {
        key: 'mc.knockback',
        type: 'choice',
        options: ['', 'true', 'false'],
      },
    ],
  },
  {
    key: 'connect',
    fields: [
      {
        key: 'connect.rejoin',
        type: 'switch',
      },
    ],
  },
]

/** Every key this build knows, for telling a stored setting from one left by an older Osmium. */
export const KNOWN_KEYS = new Set(SETTING_GROUPS.flatMap((group) => group.fields.map((field) => field.key)))

export function settingLabel(key: string): string {
  return `configuration.settings.${key.replaceAll('.', '_')}.label`
}

export function settingHint(key: string): string {
  return `configuration.settings.${key.replaceAll('.', '_')}.hint`
}

export function groupLabel(key: string): string {
  return `configuration.groups.${key}`
}

/** One option of a `choice`. Empty is a value like any other, and is keyed `auto` since a message
 * key cannot be blank. */
export function optionLabel(key: string, value: string): string {
  return `configuration.settings.${key.replaceAll('.', '_')}.options.${value || 'auto'}`
}

/**
 * What an agent is configured with, as a value for every field.
 *
 * Read off the agent rather than fetched: it arrives with every agent and changes through the same
 * live updates as everything else, so a separate request would only be a slower way to learn the
 * same thing.
 *
 * **Every known key is present, empty when unset.** What is stored holds only what an operator set,
 * and a form needs something to bind to for the rest — an absent key reaches an input as `undefined`
 * and takes the field down with it. The emptiness is put back on the way out, by {@link saveSettings}.
 *
 * A key that is stored but not declared here is kept as it is: it belongs to a newer Osmium than
 * this one, and dropping it would quietly clear a setting this build cannot show.
 */
export function settingsOf(agent: FleetAgent | undefined): AgentSettings {
  const blank = Object.fromEntries([...KNOWN_KEYS].map((key) => [key, '']))

  return { ...blank, ...(agent?.settings ?? {}) }
}

/**
 * Writes one agent's configuration.
 *
 * One request per agent, even when several are being set at once. Each is its own decision with its
 * own audit line, and a partial failure then names the agents it did not reach instead of leaving an
 * operator to guess which half of a bulk write landed.
 */
export async function saveSettings(agentId: number, values: AgentSettings): Promise<void> {
  // An empty box is a setting nobody chose, not a setting chosen to be empty. Sending it would
  // store a value the host then has to interpret as absence, which is the same thing said twice and
  // makes "cleared" and "never set" indistinguishable to everything downstream.
  const set = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''))

  const { error } = await api.PUT('/api/agents/{id}/settings', {
    params: { path: { id: agentId } },
    body: { values: set },
  })

  if (error) throw new Error(typeof error === 'string' ? error : 'Could not save the configuration')
}
