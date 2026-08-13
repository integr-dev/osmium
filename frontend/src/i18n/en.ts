/**
 * Every string the operator sees.
 *
 * Two rules for anything added here.
 *
 * **Say what happened and what to do, not why the code is built that way.** The reasoning behind a
 * design belongs in comments and in the design document; a message that explains it is asking the
 * reader to care about a decision they cannot act on.
 *
 * **Avoid the word "server" for Osmium itself.** In this product a server is a Minecraft server, so
 * Osmium is named directly and its parts are called hosts and agents.
 */
export const en = {
  common: {
    actions: 'Actions',
    cancel: 'Cancel',
    close: 'Close',
    copy: 'Copy',
    copied: 'Copied',
    delete: 'Delete',
    done: 'Done',
    edit: 'Edit',
    loading: 'Loading…',
    none: 'None',
    save: 'Save',
    status: 'Status',
  },

  /**
   * Language names are endonyms and stay identical in every locale — someone who has landed in a
   * language they cannot read needs to recognise their own in the list.
   */
  language: {
    label: 'Language',
    en: 'English',
    de: 'Deutsch',
  },

  nav: {
    openNavigation: 'Open navigation',
    closeNavigation: 'Close navigation',
    dashboard: 'Dashboard',
    map: 'Map',
    hosts: 'Hosts',
    agents: 'Agents',
    addAgent: 'Add agent',
    myAccount: 'My account',
    allAccounts: 'All accounts',
    operations: 'Operations',
    configuration: 'Configuration',
    auditLog: 'Audit log',
    logOut: 'Log out',
  },

  connection: {
    /** Shown instead of the app when nothing has loaded yet. */
    blockedTitle: 'Cannot reach Osmium',
    blockedBody: 'Osmium is not responding. Your session is still active — try again in a moment.',
    tryAgain: 'Try again',
    retrying: 'Retrying…',
    /** Shown once data has loaded and contact is then lost. */
    backendLost: 'Cannot reach Osmium. Showing the last information received. Click to retry.',
    streamLost: 'Live updates paused. Reconnecting…',
  },

  login: {
    subtitle: 'Sign in to continue',
    username: 'Username',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
  },

  dashboard: {
    title: 'Dashboard',
    building: 'Building',
    buildingName: 'Building {name}',
    stalled: 'Stalled',
    agentsOnline: 'Agents online',
    blocksPlaced: 'Blocks placed',
    throughput: 'Throughput',
    perMinute: 'blocks / minute',
    remaining: 'Est. remaining',
    atCurrentRate: 'at the current rate',
    needsAttention: 'Needs attention',
    allHealthy: 'All agents are healthy.',
    activity: 'Agent activity',
    progress: 'Schematic progress',
    percentComplete: '{percent}% complete',
    blocksRemaining: '{count} block remaining | {count} blocks remaining',
    sectors: 'Sectors',
    contribution: 'Contribution',
    activityHint: 'Alerts and status changes.',
    noActivity: 'Nothing to report.',
    noChat: 'No messages yet.',
  },

  /** Why an agent is on the attention list. Shorter than its state, and about the cause. */
  attention: {
    hostUnreachable: 'Host unreachable',
    needsRelink: 'Needs relink',
  },

  servers: {
    title: 'Active servers',
    hint: 'Select a server to read its chat.',
    online: '{online} of {total} online',
    listening: 'Chat on',
    noListenerShort: 'No chat',
    noListener: 'No agent is online here, so nothing is forwarding this server’s chat.',
    via: 'Forwarded by {name}.',
    chatTitle: 'Server chat',
    none: 'No servers yet. Add an agent to get started.',
  },

  hosts: {
    title: 'Hosts',
    subtitle: 'Machines that run your agents.',
    onlineCount: '{online} of {total} online.',
    host: 'Host',
    agents: 'Agents',
    agentCount: '{count} agent | {count} agents',
    version: 'Version',
    reachable: 'Reachable',
    unreachable: 'Unreachable',
    notConnected: 'not yet connected',
    none: 'No hosts yet.',
    enrol: 'Enrol host',
    enrolTitle: 'Enrol a host',
    enrolIntro: 'Name the host and give it the token below. The host connects to Osmium, so there is no address to enter.',
    name: 'Name',
    namePlaceholder: 'e.g. host-eu-3',
    rename: 'Rename host',
    renameHint: 'Only the name is yours to set. Address, version and status are recorded when the host connects.',
    rotateIntro: 'Issues a new token and invalidates the current one. The host disconnects until you give it the replacement; its agents are kept.',
    removeWithAgents: 'This host runs {count} agent, which is removed with it. Its token stops working. | This host runs {count} agents, which are removed with it. Its token stops working.',
    removeNoAgents: 'This host has no agents. Its token stops working.',
    rotateToken: 'Rotate token',
    rotateTitle: 'Rotate the token for {name}?',
    removeAction: 'Remove',
    rotate: 'Rotate',
    remove: 'Remove host',
    removeTitle: 'Remove {name}?',
    tokenWarning: 'Copy this now. It is shown once and cannot be retrieved later.',
    tokenHint: 'Set this as OSMIUM_HOST_TOKEN on the host.',
  },

  agents: {
    addTitle: 'Add an agent',
    identity: 'Identity',
    label: 'Name',
    labelPlaceholder: 'e.g. Mason_04',
    host: 'Host',
    server: 'Minecraft server',
    serverPlaceholder: 'mc.example.com:25565',
    add: 'Add agent',
    next: 'Next',
    back: 'Back',
    create: 'Create',
    hostStepHint: 'Which host should run this agent? A host that is offline can be chosen now and connected later.',
    noHosts: 'No hosts yet. Add one under Hosts first.',
    notFound: 'Agent not found.',
    hostOffline: '{host} is not connected, so commands cannot be sent. The host must connect to Osmium before this agent can be set up or connected.',
    editTitle: 'Edit {name}',
    editHint: 'Moving to another server keeps the same Minecraft account. The agent has to be offline first.',

    setUp: 'Set up on host',
    stats: 'Stats',
    nearbyPlayers: 'Nearby players',
    notSetUp: 'This agent has no credentials on its host yet. Setting it up prompts the host to sign in.',
    moveOffline: 'Disconnect the agent before moving it to another server.',
    setUpTitle: 'Set up {name}',
    setUpBody: 'Sign-in happens on {host}. Osmium relays your choice and never sees the credentials — finish the sign-in there, and the agent reports back when it is ready.',
    setUpStart: 'Start setup',
    connect: 'Connect',
    disconnect: 'Disconnect',
    edit: 'Edit agent',
    move: 'Move to another Minecraft server',
    removeWarning: 'The agent is removed from Osmium. Credentials stored on {host} are not affected — revoke the account there if it should stop working.',

    uptime: 'Uptime',
    health: 'Health',
    food: 'Food',
    position: 'Position',
    dimension: 'Dimension',
    noTelemetry: 'This agent has not reported recently.',
    ping: 'Ping',
    blocksPlaced: 'Blocks placed',
    nearby: 'Nearby',
    noNearby: 'No players in range.',
    activity: 'Activity',
    noActivity: 'Nothing to report.',
    chat: 'Chat',
    chatHint: '— to and from this agent. Server chat is on the dashboard.',
    chatPlaceholder: 'Send a message as this agent',
    send: 'Send',
    agentTag: 'agent',
  },

  /** A placeholder screen. Nothing is built behind it yet. */
  map: {
    title: 'Map',
    subtitle: 'Where the fleet is working.',
    empty: 'Nothing here yet.',
  },

  /** A placeholder screen. Nothing is built behind it yet. */
  operations: {
    title: 'Operations',
    subtitle: 'Run work across the fleet.',
    empty: 'Nothing here yet.',
  },

  /** MOCK, pending the backend. The field list here is a placeholder, not a specification. */
  configuration: {
    title: 'Configuration',
    subtitle: 'Configure agents without touching the machines they run on.',
    agents: 'Agents',
    selectAll: 'Select all',
    noAgents: 'No agents yet.',
    pickOne: 'Select an agent to see its settings.',
    selected: '{count} selected',
    valuesFrom: 'Showing {name}’s settings.',
    appliesTo: 'Applies to {count} agent | Applies to {count} agents',
    update: 'Update settings',
    updating: 'Sending…',
    updated: 'Settings sent to {name}.',
    updatedMany: 'Settings sent to {count} agents.',
    unsaved: 'Unsaved changes.',
    mock: 'Not wired to a host yet — changes are kept in the browser only.',
    reset: 'Discard changes',

    group: {
      connection: 'Connection',
      behaviour: 'Behaviour',
      reporting: 'Reporting',
    },

    field: {
      autoReconnect: 'Reconnect automatically',
      reconnectDelay: 'Wait before reconnecting',
      idleTimeout: 'Disconnect when idle for',
      autoEat: 'Eat when hungry',
      whenIdle: 'With nothing to build',
      viewDistance: 'View distance',
      relayChat: 'Forward server chat',
      logLevel: 'Host log detail',
    },

    option: {
      whenIdle: {
        hold: 'Stay put',
        regroup: 'Return to the build',
        disconnect: 'Leave the server',
      },
      logLevel: {
        error: 'Errors only',
        warn: 'Warnings',
        info: 'Normal',
        debug: 'Everything',
      },
    },
  },

  account: {
    title: 'My account',
    subtitle: 'Your identity, role and permissions.',
    username: 'Username',
    role: 'Role',
    noRole: 'No role',
    permissions: 'Permissions',
    noPermissions: 'This account has no permissions.',
    current: 'current',
    included: 'included',
    rename: 'Change username',
    renameWarning: 'Changing your username ends this session. You will need to sign in again.',
    roleHint: 'An account holds one role. Each level includes everything below it.',
    noRoleAssigned: 'No role assigned. An administrator has to grant one.',
    permissionsHint: 'Everything your role grants, including the levels below it.',
    renamed: 'Username changed. Please sign in again.',
    changePassword: 'Change password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmPassword: 'Confirm new password',
    confirmPlaceholder: 'Repeat the new password',
    passwordHint: 'Requires your current password. 4–72 characters.',
    passwordChanged: 'Password changed. Every other session has been signed out.',
  },

  /**
   * Deliberately plain about what these values are worth. An address is only the operator's if the
   * deployment is set up to pass it through, and a browser names itself — neither is evidence, and
   * copy that implied otherwise would invite someone to conclude too much from a row.
   */
  sessions: {
    title: 'Signed in on',
    hint: 'Where this account is signed in. A session ends 12 hours after it began, however much it is used.',
    none: 'No other sessions.',
    thisDevice: 'This device',
    startedAt: 'Signed in {when}',
    endsAt: 'Ends {when}',
    unknownDevice: 'Unknown browser',
    unknownAddress: 'Address not recorded',
    end: 'Sign out',
    ending: 'Signing out…',
    endAll: 'Sign out everywhere',
    endAllHint: 'Ends every session including this one, and immediately invalidates access already granted. Use this if you think someone else has your session.',
    endAllConfirm: 'Sign out of every session?',
    endAllWarning: 'Every browser signed in as you is signed out, this one included. You will need to sign in again.',
    failed: 'Could not end that session.',
  },

  accounts: {
    title: 'All accounts',
    subtitle: 'Only administrators can create accounts.',
    filterPlaceholder: 'Filter by username',
    count: 'Accounts',
    account: 'Account',
    role: 'Role',
    noRole: 'No role',
    nodeCount: '{count} node | {count} nodes',
    noMatches: 'No accounts match that filter.',
    create: 'Create',
    next: 'Next',
    passwordPlaceholder: '4–72 characters',
    confirmPlaceholder: 'Repeat the password',
    confirmPassword: 'Confirm password',
    newPassword: 'New password',
    confirmNewPassword: 'Confirm new password',
    confirmNewPlaceholder: 'Repeat the new password',
    username: 'Username',
    password: 'Password',
    noRoleHint: 'The account will have no permissions.',
    editTitle: 'Edit {name}',
    renameWarning: 'Renaming ends that account’s sessions, since its token identifies it by username.',
    newAccount: 'New account',
    roleHint: 'An account holds one role. Each level includes everything below it.',
    back: 'Back',
    passwordOptional: 'Leave blank to keep the current password',
    changeRole: 'Change role',
    removeRoleHint: 'Removes all permissions.',
  },

  audit: {
    title: 'Audit log',
    subtitle: 'A record of who did what, and when.',
    filterPlaceholder: 'Search account, agent, action or text',
    when: 'When',
    who: 'Account',
    action: 'Action',
    target: 'Target',
    detail: 'Detail',
    none: 'Nothing recorded yet.',
    noMatches: 'Nothing matches that search.',
    end: 'End of the audit log.',
    retention: 'Audit entries are kept for 30 days. Agent activity is kept for 10 days and chat for 3.',

    export: 'Export CSV',
    exportTitle: 'Export the audit log',
    exportHint: 'Both days are included. The file is CSV, and always in English so it stays readable by tooling.',
    exportFrom: 'From',
    exportTo: 'To',
    exporting: 'Preparing…',
    exportRecorded: 'The export is itself recorded, under your account.',
    exportOrder: 'Choose a start day on or before the end day.',
  },

  /**
   * What an agent is doing, shown on its row. Distinct from its state: the state says what Osmium
   * knows about the agent, this says what it is spending its time on.
   */
  agentTask: {
    awaitingAssignment: 'Awaiting assignment',
    notSetUp: 'Not set up yet',
    awaitingSetup: 'Awaiting setup on host',
    readyToConnect: 'Ready to connect',
    credentialsRejected: 'Credentials rejected',
    serverRefused: 'Server refused the connection',
    hostUnreachable: 'Host unreachable',
    idle: 'Idle',
  },

  /** The lifecycle of an agent, as an operator reads it. */
  agentState: {
    ONLINE: 'Online',
    LINKED: 'Ready',
    UNLINKED: 'Not set up',
    SETUP_PENDING: 'Setting up',
    NEEDS_RELINK: 'Needs sign-in',
    CONNECT_FAILED: 'Connection failed',
    STALE: 'Unknown',
  },

  auditAction: {
    AGENT_CREATE: 'Agent created',
    AGENT_UPDATE: 'Agent edited',
    AGENT_DELETE: 'Agent deleted',
    AGENT_SETUP: 'Set up',
    AGENT_CONNECT: 'Connect',
    AGENT_DISCONNECT: 'Disconnect',
    AGENT_CHAT: 'Chat',
    HOST_ENROL: 'Host enrolled',
    HOST_RENAME: 'Host renamed',
    HOST_ROTATE_TOKEN: 'Token rotated',
    HOST_DELETE: 'Host deleted',
    USER_CREATE: 'Account created',
    USER_UPDATE: 'Account edited',
    USER_DELETE: 'Account deleted',
    USER_ROLE_CHANGE: 'Role changed',
    USER_PASSWORD_CHANGE: 'Password changed',
    AUDIT_EXPORT: 'Log exported',
    SESSION_REUSE_DETECTED: 'Session token replayed',
    SESSION_REVOKED_ALL: 'Signed out everywhere',
  },

  /**
   * Permission names. The raw node string stays the source of truth and is what the API authorizes
   * against; an unmapped node falls back to its own id so a new one still renders.
   */
  permission: {
    'user.read.self': 'View own account',
    'user.edit.self': 'Rename own account',
    'user.read': 'View all accounts',
    'user.edit': 'Edit any account',
    'user.create': 'Create accounts',
    'user.delete': 'Delete accounts',
    'user.role.write': 'Assign roles',
    'role.read': 'View roles',
    'audit.read': 'View the audit log',
    'audit.export': 'Export the audit log',
    'fleet.read': 'View hosts and agents',
    'fleet.control': 'Manage and control agents',
    'fleet.chat': 'Speak in game as an agent',
    'fleet.login': 'Enrol hosts and set up agents',
  },

  loginMethod: {
    method_a: { label: 'Method A', description: 'Placeholder. Performed on the host.' },
    method_b: { label: 'Method B', description: 'Placeholder. Performed on the host.' },
    method_c: { label: 'Method C', description: 'Placeholder. Performed on the host.' },
    method_d: { label: 'Method D', description: 'Placeholder. Performed on the host.' },
  },

  errors: {
    loadSessions: 'Could not load your sessions.',
    generic: 'Something went wrong.',
    unreachable: 'Cannot reach Osmium',
    invalidCredentials: 'Incorrect username or password.',
    loginFailed: 'Could not sign in.',
    passwordMismatch: 'The passwords do not match.',
    pickHost: 'Pick a host to run this agent.',
    commandFailed: 'The command failed.',
    loadHosts: 'Could not load hosts.',
    loadAgents: 'Could not load agents.',
    loadAudit: 'Could not load the audit log.',
    exportAudit: 'Could not export the audit log.',
    loadActivity: 'Could not load activity.',
    loadChat: 'Could not load chat.',
    loadAccounts: 'Could not load accounts.',
    enrolHost: 'Could not enrol the host.',
    renameHost: 'Could not rename the host.',
    rotateToken: 'Could not rotate the token.',
    removeHost: 'Could not remove the host.',
    createAgent: 'Could not create the agent.',
    updateAgent: 'Could not update the agent.',
    removeAgent: 'Could not remove the agent.',
    setUpAgent: 'Could not start setup.',
    connectAgent: 'Could not connect.',
    disconnectAgent: 'Could not disconnect.',
    sendMessage: 'Could not send the message.',
    renameAccount: 'Could not change the username.',
    createAccount: 'Could not create the account.',
    updateAccount: 'Could not update the account.',
    removeAccount: 'Could not delete the account.',
    changeRole: 'Could not change the role.',
    changePassword: 'Could not change the password.',
  },
} as const

type Translated<T> = { readonly [K in keyof T]: T[K] extends string ? string : Translated<T[K]> }

/**
 * The shape every other locale has to match. English is the source: a key added here fails the
 * build in every translation that has not caught up, which is the only reliable reminder.
 */
export type Copy = Translated<typeof en>
