import { t } from '../i18n'

/**
 * **MOCK, pending the backend.** Nothing here reaches an agent — `saveSettings` writes to a map in
 * this module and resolves. It exists so the screen can be designed and argued about before the
 * wire format is settled.
 *
 * Kept out of the fleet store deliberately, exactly as `BuildProgress` is: the store holds what the
 * backend really said, and mixing invented values into it is how a mock outlives the thing it was
 * standing in for.
 *
 * The field list is a placeholder. What survives to the real version is the shape — a declared
 * schema the view renders generically — rather than any particular setting, so adding one later is
 * an entry here and a copy key, not another block of markup.
 */

export type SettingValue = string | number | boolean

export interface SettingField {
  key: string
  /** Chosen by what the value *is*, so the view never switches on the key itself. */
  type: 'toggle' | 'number' | 'select'
  /** `select` only. */
  options?: string[]
  /** `number` only, and advisory — the mock does not enforce them. */
  min?: number
  max?: number
  unit?: string
}

export interface SettingGroup {
  key: string
  fields: SettingField[]
}

export type AgentSettings = Record<string, SettingValue>

export const SETTING_GROUPS: SettingGroup[] = [
  {
    key: 'connection',
    fields: [
      { key: 'autoReconnect', type: 'toggle' },
      { key: 'reconnectDelay', type: 'number', min: 1, max: 600, unit: 's' },
      { key: 'idleTimeout', type: 'number', min: 0, max: 3600, unit: 's' },
    ],
  },
  {
    key: 'behaviour',
    fields: [
      { key: 'autoEat', type: 'toggle' },
      { key: 'whenIdle', type: 'select', options: ['hold', 'regroup', 'disconnect'] },
      { key: 'viewDistance', type: 'number', min: 2, max: 32 },
    ],
  },
  {
    key: 'reporting',
    fields: [
      { key: 'relayChat', type: 'toggle' },
      { key: 'logLevel', type: 'select', options: ['error', 'warn', 'info', 'debug'] },
    ],
  },
]

const DEFAULTS: AgentSettings = {
  autoReconnect: true,
  reconnectDelay: 15,
  idleTimeout: 300,
  autoEat: true,
  whenIdle: 'hold',
  viewDistance: 8,
  relayChat: true,
  logLevel: 'info',
}

/** Stands in for what the backend would hold. Survives navigation, not a reload. */
const stored = new Map<number, AgentSettings>()

/**
 * Varied by agent id so selecting different agents visibly shows different configurations —
 * otherwise the screen looks like it ignores the selection.
 */
export async function loadSettings(agentId: number): Promise<AgentSettings> {
  const held = stored.get(agentId)
  if (held) return { ...held }

  return {
    ...DEFAULTS,
    autoReconnect: agentId % 3 !== 0,
    reconnectDelay: 5 + (agentId % 4) * 10,
    viewDistance: [4, 8, 12, 16][agentId % 4],
    logLevel: ['info', 'warn', 'debug', 'info'][agentId % 4],
    relayChat: agentId % 2 === 0,
  }
}

export async function saveSettings(agentId: number, settings: AgentSettings): Promise<void> {
  stored.set(agentId, { ...settings })
}

/** Labels live with the rest of the copy; an unmapped key falls back to itself rather than vanishing. */
export function settingLabel(key: string): string {
  const label = t(`configuration.field.${key}`)
  return label === `configuration.field.${key}` ? key : label
}

export function optionLabel(field: string, option: string): string {
  const label = t(`configuration.option.${field}.${option}`)
  return label === `configuration.option.${field}.${option}` ? option : label
}
