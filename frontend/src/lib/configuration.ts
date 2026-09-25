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
  type: 'regex' | 'text' | 'switch' | 'choice' | 'players' | 'proxy' | 'range'
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
  /**
   * For a `range`, the ends and the notch. The words for the two ends come from i18n, keyed by the
   * field - see {@link rangeEnd} - because a slider is a trade, and a bare number at either end would
   * not say which way is which.
   */
  min?: number
  max?: number
  step?: number
  /**
   * For a `range` whose position is a number somebody reads - a multiplier - rather than a trade, the
   * value is shown between its two ends. Its `default` is where the thumb sits while it is unset.
   */
  readout?: boolean
  /**
   * Whether this field is worth showing at all, given the rest.
   *
   * For a setting that only means something when another is set a particular way. A predicate rather
   * than a little language of dependencies: there is one of these, it lives beside the field it is
   * about, and a rule somebody can read is worth more than a rule somebody can parameterise.
   *
   * Hidden, not disabled, and the value is left alone either way — a field nobody can act on is
   * clutter, and clearing it would lose a choice the operator made before turning the other one off.
   */
  showWhen?: (settings: AgentSettings) => boolean
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

/** How an agent sends a private message back. `{name}` and `{message}` are filled in.
 *
 * `/msg` is what vanilla, Essentials and most plugin suites answer to, so it is the guess most likely
 * to work on a server nobody has configured. */
export const VANILLA_WHISPER_COMMAND = '/msg {name} {message}'

/**
 * The order is the order of the tabs, and the first group is what an operator lands on.
 *
 * Roughly how early a setting matters to an agent: what it speaks, then how it behaves once it is
 * in the world, then whether it stays there, then who may talk to it. Chat last because it is the
 * one an operator comes back to and tunes, rather than the one they set on the way in.
 */
export const SETTING_GROUPS: SettingGroup[] = [
  {
    key: 'mc',
    fields: [
      {
        key: 'mc.version',
        type: 'text',
        placeholder: '1.21.4',
      },
    ],
  },
  {
    /*
     * What an agent does for itself while nobody is watching it.
     *
     * Knockback lives here rather than under Minecraft, where it started. It is not a fact about the
     * protocol like a version is; it is a module in the same sense as the rest of these - something
     * switched on to change how the agent behaves in the world - and an operator looking for "stop
     * it being pushed off the scaffold" looks here.
     *
     * Ordered by how much they claim. The first three do what a player does; the last two tell the
     * server something untrue, and sit at the bottom where a scroll to reach them is a small pause
     * for thought.
     */
    key: 'util',
    fields: [
      {
        // Three states rather than a switch: a server with a `/dupe` plugin makes "never run out" a
        // real answer, and one without makes it a bannable one. The operator says which they are on.
        key: 'util.autoEat',
        type: 'choice',
        options: ['', 'on', 'dupe'],
      },
      {
        key: 'util.autoTotem',
        type: 'choice',
        options: ['', 'on', 'dupe'],
      },
      {
        key: 'util.fleeDistance',
        type: 'text',
        placeholder: '32',
      },
      {
        key: 'mc.takeKnockback',
        type: 'choice',
        options: ['', 'false'],
      },
      {
        // Only means anything while knockback is being taken. With it off nothing is applied, so
        // there is no arithmetic to correct and the question does not arise.
        key: 'mc.knockback',
        type: 'choice',
        options: ['', 'true', 'false'],
        showWhen: (settings) => settings['mc.takeKnockback'] !== 'false',
      },
      {
        key: 'util.antiHunger',
        type: 'choice',
        options: ['', 'careful', 'spoof'],
      },
      { key: 'util.noFall', type: 'switch' },
    ],
  },
  {
    /*
     * How an agent gets from one place to another.
     *
     * After the utility modules and before connecting, which is roughly when an operator meets
     * them: what a bot does for itself, then how it moves about, then whether it stays.
     *
     * **Three of these are permissions rather than preferences**, and they are permissions over
     * somebody else's world. Upstream's pathfinder will happily dig through a wall, pillar into the
     * air and jump a four block gap to save nine blocks of walking, because it is written for a bot
     * somebody is watching. None of that is undoable on a server an operator does not own, so each
     * is off until it is turned on and a route that needs one is simply not found.
     */
    key: 'path',
    fields: [
      // Walks unless flight is asked for. The host flies only where the server allows it, unless the
      // second switch says to fly anyway - which only means anything once flying is asked for.
      { key: 'path.mode', type: 'choice', options: ['', 'fly'] },
      {
        key: 'path.flyCommand',
        type: 'text',
        placeholder: '/fly',
        showWhen: (settings) => settings['path.mode'] === 'fly',
      },
      {
        key: 'path.flySpeed',
        type: 'range',
        min: 0.25,
        max: 5,
        step: 0.25,
        default: '1',
        readout: true,
        showWhen: (settings) => settings['path.mode'] === 'fly',
      },
      { key: 'path.forceFly', type: 'switch', showWhen: (settings) => settings['path.mode'] === 'fly' },
      {
        // A search cannot see past the chunks the server has sent, which is a dozen wide at most -
        // so a bigger number here does not find longer routes, it spends the budget looking at
        // ground the host has not got. Long journeys are walked as a run of short ones.
        key: 'path.range',
        type: 'text',
        placeholder: '128',
      },
      { key: 'path.dig', type: 'switch' },
      { key: 'path.bridge', type: 'switch' },
      { key: 'path.parkour', type: 'switch' },
      {
        key: 'path.maxDrop',
        type: 'text',
        placeholder: '3',
      },
      {
        /*
         * Route quality against search speed, as a position rather than a number - see `leanFor` in the
         * host's settings.ts for what the ends are worth. Unset is the middle, which is exactly how
         * agents planned before this was a setting, so nobody's agent changes because the field appeared.
         */
        key: 'path.haste',
        type: 'range',
        min: 0,
        max: 100,
        step: 5,
      },
    ],
  },
  {
    /*
     * How an agent puts a piece down.
     *
     * Its own group rather than part of movement, because building is a different job with a
     * different failure: a badly set reach does not send an agent the long way round, it has the
     * server refuse every placement it tries. The order the blocks go down in is not here — that
     * belongs to the job, not to the agent, and is chosen when the build is started.
     */
    key: 'build',
    fields: [
      {
        // The only number here the server also has an opinion about: past its own limit it
        // refuses the interaction, so a larger number places nothing rather than placing further.
        key: 'build.reach',
        type: 'range',
        min: 2,
        max: 5.5,
        step: 0.5,
        default: '4.5',
        readout: true,
      },
      {
        key: 'build.window',
        type: 'text',
        placeholder: '2048',
      },
      {
        key: 'build.rate',
        type: 'range',
        min: 1,
        max: 40,
        step: 1,
        default: '12',
        readout: true,
      },
      {
        /*
         * A choice rather than a switch, because unset has to mean *on* here and a switch cannot
         * say that: it writes the empty string for off, which is the same thing an untouched
         * setting holds. Finishing a state is part of building it correctly, so the default is to
         * do it and the operator turns it off.
         */
        key: 'build.tune',
        type: 'choice',
        options: ['', 'false'],
      },
      {
        // Unset is on here too, and for the same reason: a piece asks for blocks whose neighbours
        // come later in its own order, and refusing to place those loses them.
        key: 'build.airPlace',
        type: 'choice',
        options: ['', 'false'],
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
      {
        /*
         * A `proxy` rather than a `choice`, because the options are not this file's to declare.
         * What a host can route through is a file on that machine, announced in its handshake — so
         * the values come from the fleet, and the labels are the operator's own names for them
         * rather than copy keyed here.
         */
        key: 'connect.proxy',
        type: 'proxy',
      },
      {
        /*
         * Hidden while a proxy is picked, because it would not be honoured: the proxy opens the
         * connection to the server, and which address family it opens it over is its own business.
         * The same reasoning as the knockback field above, which hides itself when nothing is
         * applying knockback in the first place.
         */
        key: 'connect.family',
        type: 'choice',
        options: ['', 'ipv4', 'ipv6'],
        showWhen: (settings) => !settings['connect.proxy'],
      },
    ],
  },
  {
    key: 'players',
    fields: [
      {
        key: 'players.whitelist',
        type: 'players',
      },
    ],
  },
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
      {
        key: 'chat.whisperCommand',
        type: 'text',
        placeholder: VANILLA_WHISPER_COMMAND,
      },
    ],
  },
]

/**
 * Mojang's rules for a username: letters, digits and underscore, up to sixteen.
 *
 * The same test the host applies to a name it reads out of a chat line. A list is only useful if
 * what goes in it could actually be a player, and a typo caught at the keyboard is one that never
 * becomes an entry that silently matches nobody.
 */
export const USERNAME = /^[A-Za-z0-9_]{1,16}$/

/**
 * How far a player on the list is trusted.
 *
 * **Two powers, not one.** `chat` lets somebody ask an agent about itself; `commands` also lets
 * them put words of their choosing in its mouth and run server commands through it, under whatever
 * permissions the agent's Minecraft account
 * holds. That second one is close to handing over the account — on an operator bot it is `/op` — so
 * it is a deliberate second step rather than something being on the list already grants.
 */
export const TRUST = { chat: 'chat', commands: 'commands' } as const

export type Trust = (typeof TRUST)[keyof typeof TRUST]

/**
 * Every command an agent answers in game, and which tier reaches it.
 *
 * **A copy of the host's table**, which is the authority - a host is a separate program and may be
 * older or newer than this interface. What that costs is a command list that can go stale; what it
 * buys is a picker that can show names at all. A command this build has never heard of survives a
 * round trip untouched rather than being dropped, so an older interface cannot silently revoke what
 * a newer one granted.
 */
export const COMMANDS = {
  id: TRUST.chat,
  ping: TRUST.chat,
  health: TRUST.chat,
  food: TRUST.chat,
  uptime: TRUST.chat,
  job: TRUST.chat,
  eta: TRUST.chat,
  help: TRUST.chat,
  '8ball': TRUST.chat,
  cf: TRUST.chat,
  roll: TRUST.chat,
  say: TRUST.commands,
  run: TRUST.commands,
  goto: TRUST.commands,
  disconnect: TRUST.commands,
  reconnect: TRUST.commands,
} as const satisfies Record<string, Trust>

export type CommandName = keyof typeof COMMANDS

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[]

/**
 * What a player on the list may do: exactly these commands, and nothing else.
 *
 * **One shape, not a tier and a list.** The host still reads the two tiers, because settings
 * written before this existed hold them - but nothing here writes one. A tier is a name for a set
 * somebody has to learn, and every question an operator actually asks of this list ("can they use
 * `run`?") is a question about the set. So the set is the whole model, and a tier read from an
 * older setting is expanded into it on the way in.
 */
export interface TrustedPlayer {
  name: string
  commands: string[]
}

/** The written form of a grant that names no commands at all, which is a real thing to mean. */
export const NOTHING = 'none'

/** The commands the old `chat` tier reached, which is what a bare name in a stored setting means. */
export const CHAT_COMMANDS: CommandName[] = COMMAND_NAMES.filter((name) => COMMANDS[name] === TRUST.chat)

/** Whether a command is one of the powerful ones, which is what an interface colours. */
export function elevated(command: string): boolean {
  return COMMANDS[command as CommandName] === TRUST.commands
}

/**
 * A player list, from the one string a setting can hold.
 *
 * Comma-separated, because a setting is a string and this has to survive a round trip through a map
 * the backend stores whole and never reads. Tolerant on the way in — commas, spaces or newlines, in
 * any combination — since the obvious thing to do with a box of names is paste some.
 */
export function playersFrom(value: string | undefined): TrustedPlayer[] {
  const seen = new Set<string>()
  const players: TrustedPlayer[] = []

  for (const entry of (value ?? '').split(/[\s,]+/)) {
    // `name`, `name:tier` or `name:one+two`. A username cannot contain a colon, so the first split
    // is unambiguous; `+` joins the commands because the entries themselves are comma-separated.
    const [name, granted] = entry.split(':')
    if (!name || !USERNAME.test(name)) continue

    // Minecraft compares names case-insensitively, so two spellings are one entry — and the first
    // spelling wins, because that is the one somebody actually typed.
    if (seen.has(name.toLowerCase())) continue

    seen.add(name.toLowerCase())
    players.push({ name, commands: commandsFrom(granted) })
  }

  return players
}

/**
 * What was written after the colon, as the set of commands it means.
 *
 * The two tiers are read and expanded, because that is what a setting written before this existed
 * holds - and an entry that says `commands` genuinely did mean all of them. Nothing writes a tier
 * back, so a list normalises to its commands the first time the form is saved.
 *
 * Unknown words are kept rather than dropped, which is the one decision here worth stating. A list
 * is written by whichever Osmium the operator happened to be using, and this build may be the older
 * one; discarding a name it does not recognise would quietly revoke a grant every time an older
 * interface saved the form. Nothing is granted by keeping it - the host decides, and it refuses
 * what it cannot name.
 */
export function commandsFrom(written: string | undefined): string[] {
  if (written === undefined || written === '' || written === TRUST.chat) return [...CHAT_COMMANDS]
  if (written === TRUST.commands) return [...COMMAND_NAMES]
  if (written === NOTHING) return []

  // Only a tier is a tier; anything else is a list, even of one. A word this build cannot name is
  // still a list of one thing, and falling back to a tier here would grant the chat commands the
  // operator did not ask for.
  return [...new Set(written.split('+').filter((word) => word.length > 0))]
}

/** The inverse. Empty stays empty, which is what {@link saveSettings} strips as "never set".
 *
 * The tier is written only when it is the elevated one, so the ordinary case stays a plain list of
 * names — readable in the database, and unchanged from before the tiers existed. */
export function playersTo(players: TrustedPlayer[]): string {
  return players.map(({ name, commands }) => `${name}:${commandsTo(commands)}`).join(',')
}

/**
 * The inverse of {@link commandsFrom}.
 *
 * Always explicit, never a tier. An entry read as `commands` is written back as every command it
 * meant - longer, and worth it: what is stored then says what is granted, and adding a command to
 * this build cannot widen a grant somebody already made.
 *
 * Granting nothing is spelled out rather than written as an empty suffix, which would read back as
 * the chat tier and hand back the harmless commands that were just taken away.
 */
export function commandsTo(commands: string[]): string {
  return commands.length ? commands.join('+') : NOTHING
}

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

/** The i18n key for one end of a `range` field: `low` is its minimum, `high` its maximum. */
export function rangeEnd(key: string, end: 'low' | 'high'): string {
  return `configuration.settings.${key.replaceAll('.', '_')}.${end}`
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
