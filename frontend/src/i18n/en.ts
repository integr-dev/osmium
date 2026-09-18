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
    dismiss: 'Dismiss',
    copied: 'Copied',
    /** The token is shown once, so a failed copy has to say what to do rather than nothing. */
    copyFailed: 'Your browser would not let Osmium reach the clipboard. Select the value above and copy it yourself before closing this.',
    delete: 'Delete',
    done: 'Done',
    edit: 'Edit',
    loading: 'Loading…',
    none: 'None',
    save: 'Save',
    /** In-flight labels, so a slow request reads as work rather than as a dead button. */
    saving: 'Saving…',
    deleting: 'Deleting…',
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

  /** The palettes. Osmium is a name; the others say what they look like. */
  theme: {
    label: 'Theme',
    /** Follows the operating system between Osmium and Osmium Light. */
    system: 'System',
    osmium: 'Osmium',
    osmiumLight: 'Osmium Light',
    pine: 'Pine',
    meadow: 'Meadow',
    graphite: 'Graphite',
    paper: 'Paper',
    contrast: 'Contrast',
    chalk: 'Chalk',
  },

  nav: {
    openNavigation: 'Open navigation',
    closeNavigation: 'Close navigation',
    resizeSidebar: 'Resize the sidebar',
    dashboard: 'Dashboard',
    map: 'Map',
    hosts: 'Hosts',
    resources: 'Resources',
    agents: 'Agents',
    addAgent: 'Add agent',
    myAccount: 'My account',
    allAccounts: 'All accounts',
    operations: 'Operations',
    configuration: 'Configuration',
    auditLog: 'Audit log',
    storage: 'Storage',
    logOut: 'Log out',
  },

  /**
   * Ctrl/⌘-K. The section names are nouns rather than verbs — the list is what you can reach, not
   * what you are being told to do.
   */
  palette: {
    hint: '{keys} to search',
    placeholder: 'Search agents, hosts and pages…',
    noMatches: 'Nothing matches that.',
    connectAgent: 'Connect {name}',
    disconnectAgent: 'Disconnect {name}',
    toggleChat: 'Toggle chat',
    chatServer: 'Chat: {server}',
    refresh: 'Refresh the fleet',
    language: 'Language: {name}',
    theme: 'Theme: {name}',
    section: {
      navigate: 'Pages',
      agents: 'Agents',
      hosts: 'Hosts',
      actions: 'Actions',
    },
  },

  /**
   * The rail beside the page. "Speak as" rather than "send as": the message goes out under a
   * Minecraft account, and everyone in game reads it as that player talking.
   */
  chat: {
    searchPlaceholder: 'Search everything that was said…',
    searchingEverywhere: 'Searching every server, not just this view.',
    searchingHere: 'Searching this conversation only.',
    title: 'Chat',
    toggle: 'Toggle chat ({keys})',
    resize: 'Resize the chat rail',
    scope: 'What to show',
    servers: 'Servers',
    agents: 'Agents',
    speakAs: 'Speak as',
    listening: 'listening',
    notListening: 'no listener',
    noListener: 'No agent is online here, so nothing is forwarding this server’s chat.',
    noServers: 'No servers yet. Assign an agent to one to read its chat.',
    noSpeaker: 'Nobody is in game here to speak through.',
    /** A line the host could not attribute to any player: a join notice, command output, or a chat
     * format it has no pattern for. Never the agent that happened to overhear it. */
    fromServer: 'server',
    /**
     * A burst of live lines arriving at once — a backgrounded tab whose stream was buffered, looked
     * at again. Says that the transcript jumping is the backlog landing rather than a glitch.
     */
    catchingUp: 'catching up…',
    /**
     * A run of lines the backend refused as repetition, drawn where they would have been. Says
     * "suppressed" rather than "deleted": they were never stored, so nothing was removed.
     */
    suppressed: '{count} suppressed as repetition',
    suppressedFrom: '{count} from {name} suppressed as repetition',
    speakerOffline: '{name} is not in game.',
    hostOffline: 'Host {host} is unreachable.',
  },

  /**
   * The browser tab, rotated through every few seconds. Short: a tab shows about twenty characters
   * before the browser truncates it, and a truncated fact is worse than a shorter one.
   */
  title: {
    plain: 'Osmium',
    /** The name stays in front, so the tab is identifiable whichever fact is showing. */
    prefixed: 'Osmium · {text}',
    offline: 'offline',
    online: '{online}/{total} in game',
    built: '{percent}% built',
    eta: 'ETA {minutes}m',
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
    /**
     * Nothing on a page can say this for itself. Every list is stream-fed and none of them poll, so
     * a frozen screen and a quiet one look identical without it.
     */
    streamLostBody: 'What is on screen is real but has stopped updating — agent states, upload progress and new rows are all waiting on the connection. Nothing has been lost.',
  },

  /**
   * The corner stack. Two kinds of line only: a receipt for something whose result is on another
   * page, and something the stream reported while the operator was looking elsewhere. Short, because
   * a notice that expires is not the place to explain anything.
   */
  toast: {
    /** Over the spread deck, only with two or more notices up. */
    clearAll: 'Clear all ({count})',
    hostRemoved: 'Removed {name}. Its agents went with it.',
    agentRemoved: 'Removed {name}.',
    jobDone: '{name} finished — every piece is built.',
    /** The count of how many is on the notice, so this stays singular however often it repeats. */
    segmentFailed: 'A piece of {name} failed. Open the job to see what the host said.',
    hostUnreachable: '{name} stopped answering. Its agents are offline until it comes back.',
    /** How a journey ended. `{goal}` is whole-block coordinates, two of them for a column. */
    path: {
      arrived: '{name} arrived at {goal}.',
      closest: '{name} found no path to {goal}, so it is walking as close as it can get.',
      none: '{name} found no path to {goal}.',
      timedOut: '{name} found no path to {goal} before the search ran out of time.',
      noBlocks: '{name} found no path to {goal}: it has no blocks left to build with.',
      unloaded: '{name} found no path to {goal}: the world around it has not loaded yet.',
      broke: '{name} gave up on the way to {goal}: working out the route failed. The host log says why.',
      couldNotPlace: '{name} gave up on the way to {goal}: it could not place a block.',
      couldNotBreak: '{name} gave up on the way to {goal}: it could not break a block.',
      putBack: '{name} gave up on the way to {goal}: the server kept putting it back.',
      failed: '{name} gave up on the way to {goal}.',
      /** A reason this build does not know yet, in the host's own words. */
      failedBecause: '{name} gave up on the way to {goal}: {reason}.',
    },
    agent: {
      dropped: '{name} dropped out of the game. Osmium is bringing it back.',
      left: '{name} left the game.',
      connectFailed: '{name} could not join {server}.',
      needsRelink: '{name} needs linking again before it can join.',
      gaveUp: 'Osmium stopped trying to bring {name} back.',
    },
    schematic: {
      ready: '{name} is ready to build.',
      failed: '{name} could not be read. Open it in the library to see why.',
    },
  },

  login: {
    subtitle: 'Sign in to continue',
    username: 'Username',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    capsLock: 'Caps Lock is on',
    /** Said before a password is spent on a backend that was never going to answer. */
    reachable: 'Osmium is responding',
    unreachable: 'Osmium is not responding',
    /** Its own key rather than the Accounts page's: rewording that one must not reword this. */
    noSignUp: 'Only administrators can create accounts.',
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
    ofTarget: 'of {total}',
    /** Segments finished, where an invented layer count used to be. */
    segmentsDone: '{done} of {total} segments built',
    /** A fleet with nothing running, which is its ordinary state. */
    buildingNothing: 'Nothing is being built.',
    /** No rate means no arithmetic to do, rather than an estimate of zero. */
    noEta: 'stalled',
    needsAttention: 'Needs attention',
    serverScope: 'Which server this page is about',
    allServers: 'All servers',
    allHealthy: 'All agents are healthy.',
    activity: 'Agent activity',
    progress: 'Blocks remaining',
    percentComplete: '{percent}% complete',
    blocksRemaining: '{count} block remaining | {count} blocks remaining',
    activityHint: 'Alerts and status changes.',
    /** The backend keeps six hours in memory, so a restart starts the trend again. */
    trendKept: 'last {minutes} min',
    trendStarting: 'building a trend…',
    noActivity: 'Nothing to report.',
    noChat: 'No messages yet.',
    range: 'Time range',
    ranges: { '15m': '15 min', '1h': '1 h', '6h': '6 h' },
    remainingLine: 'Remaining',
    projectedLine: 'At the current rate',
    finishAt: 'done around {time}',
    noBurndown: 'Nothing was being built in this range.',
    traffic: 'Traffic',
    trafficHint: 'All hosts, per second.',
    linkSent: 'Backend → hosts',
    linkReceived: 'Hosts → backend',
    gameSent: 'Agents → servers',
    gameReceived: 'Servers → agents',
    gameUnreported: 'No host reports game traffic yet.',
    noHistory: 'No history yet. The first point arrives within ten seconds.',
    hosts: 'Hosts',
    hostAgents: '{online}/{total} online',
    noHosts: 'No hosts enrolled.',
    link: 'Backend link',
    game: 'Game servers',
    sentReceived: 'sent ↑ / received ↓',
    severity: { INFO: 'Info', WARNING: 'Warnings', ERROR: 'Errors' },
    perBucket: 'Incidents per {minutes} min',
    loadedSince: 'loaded back to {time}, scroll the feed for more',
  },

  /** Why an agent is on the attention list. Shorter than its state, and about the cause. */
  attention: {
    hostUnreachable: 'Host unreachable',
    needsRelink: 'Needs relink',
    lowHealth: 'Low health',
    lowFood: 'Low food',
    highPing: 'High ping',
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
    rotating: 'Rotating…',
    removing: 'Removing…',
    remove: 'Remove host',
    removeTitle: 'Remove {name}?',
    tokenWarning: 'Copy this now. It is shown once and cannot be retrieved later.',
    tokenHint: 'Set this as OSMIUM_HOST_TOKEN on the host.',
    notFound: 'Host not found.',
    lastSeen: 'Last seen',
    neverSeen: 'Never',
    agentsHere: 'Agents on this host',
    noAgentsHere: 'This host runs no agents yet.',
    loginMethods: 'Login methods',
    noMethodsAdvertised: 'This host has not said what it can log in with. It reports that when it connects.',
  },

  /** What this deployment is made of, as opposed to what is being done with it. */
  resources: {
    title: 'Resources',
    subtitle: 'The agents, the machines that run them, and how the two are wired together.',
    tabBots: 'Bots',
    tabHosts: 'Hosts',
    tabProxies: 'Proxies',
    tabGraph: 'Graph',
  },

  /** The wiring, drawn. The three link states are the same three the rest of the app uses. */
  graph: {
    hint: 'Every line is a connection or a route. Packets flow while one is carrying traffic.',
    /** The outermost tier. Not "connections": nothing along them reports to Osmium. */
    servers: 'Minecraft servers',
    live: 'Connected',
    stale: 'Faltering',
    down: 'Not connected',
    empty: 'No hosts have connected yet, so there is nothing to draw.',
    reducedMotion: 'Motion is off, so the packets are not shown.',
    hintMove: 'Scroll to zoom, drag to move.',
    reset: 'Fit',
  },

  agents: {
    addTitle: 'Add an agent',
    identity: 'Identity',
    label: 'Name',
    labelPlaceholder: 'e.g. Mason_04',
    host: 'Host',
    server: 'Minecraft server',
    serverPlaceholder: 'mc.example.com',
    add: 'Add agent',
    next: 'Next',
    back: 'Back',
    create: 'Create',
    hostStepHint: 'Which host should run this agent? A host that is offline can be chosen now and connected later.',
    noHosts: 'No hosts yet. Add one under Hosts first.',
    notFound: 'Agent not found.',
    none: 'No agents yet.',
    onlineCount: '{online} of {total} in game.',
    account: 'Account',
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
    /** The list comes from the host, so an empty one is a fact about it and not about Osmium. */
    noLoginMethods: '{host} has not said what it can log in with. It reports that when it connects, so check that it is running and up to date.',
    setUpStart: 'Start setup',
    connect: 'Connect',
    /** While the command is out and the host has not answered. See AgentState.CONNECTING. */
    connecting: 'Connecting…',
    /**
     * Why a grey button is grey. The wizard in Operations already says this out loud; these are the
     * same sentence for the three commands on an agent's own page.
     */
    blockedHost: '{host} is not connected, so nothing can be sent to it.',
    blockedSettingUp: 'A sign-in is already running on the host.',
    blockedOnlineSetup: 'Disconnect this agent before setting it up again.',
    blockedConnecting: 'Already on its way in — waiting for the host to report.',
    blockedAlreadyOnline: 'Already in game.',
    blockedUnlinked: 'Not set up yet: it has no Minecraft account to join with.',
    blockedNoServer: 'Assigned to no server, so there is nowhere to connect to.',
    blockedNotOnline: 'Not in game, so there is no session to end.',
    blockedNotConnected: 'Not connected, and not trying to be.',
    blockedNotOnlineWalk: 'Not in game, so there is nowhere to walk.',
    blockedBuildingWalk: 'Building — walking it away would leave blocks wherever it ended up.',
    blockedNoDestination: 'Type a destination first.',
    blockedNotWalking: 'Going nowhere.',
    /** Where an agent plays decides what its *next* connection targets, so it is an offline edit. */
    blockedOnlineServer: 'Disconnect this agent before changing the server it plays on.',
    cancelConnect: 'Cancel',
    /**
     * Between the press and the host reporting that it stopped.
     *
     * Its own word rather than the button going quiet, because the gap is real: an attempt is
     * abandoned where it next gives up the thread, and a lookup or a version ping is a round trip.
     */
    cancelling: 'Cancelling…',
    stopRejoining: 'Stop trying',
    /**
     * SETUP_PENDING is open-ended by design, so the way out is the operator saying it is not coming.
     * The copy is careful: this stops Osmium waiting, it does not reach into the host.
     */
    pendingTitle: 'Waiting on a sign-in at {host}',
    pendingBody: 'Osmium cannot see how far along it is, so it waits indefinitely. If the sign-in was started somewhere you cannot get back to, stop waiting and set the agent up again — nothing is sent to the host, and if it does finish the agent still links.',
    stopWaiting: 'Stop waiting',
    disconnect: 'Disconnect',
    edit: 'Edit agent',
    move: 'Move to another Minecraft server',

    /**
     * Where an agent plays is its own action, not a field on the edit: a rename is cosmetic and
     * always allowed, while this decides what the next connection targets and is offline-only.
     */
    serverOptional: 'Minecraft server (optional)',
    serverLaterHint: 'Leave blank to decide later. An agent can be set up before it has anywhere to play.',
    noServer: 'No server',
    notLinked: 'Not set up',
    notBuilding: 'Not building',
    /** The tooltip behind the substituted badge — which piece of which build. */
    buildingOn: "Segment {ordinal} of '{build}'",
    setServer: 'Change server',
    actionsSession: 'Session',
    actionsWalk: 'Movement',
    walkX: 'X',
    walkY: 'Y',
    /** The placeholder, which is where the box says it may be left alone. */
    walkYAny: 'Y — any',
    walkYHint: 'Leave blank to reach that spot at whatever height the ground turns out to be.',
    walkZ: 'Z',
    walkHere: 'Here',
    walkHereHint: 'Fill the boxes with where the agent is standing.',
    walkGo: 'Go',
    walkStop: 'Stop',
    /** Said while the host is still searching, when there is a goal and no path yet. */
    walkPlanning: 'Finding a route to {goal}…',
    /** The node count rather than a percentage: a re-plan changes the length, and a percentage
     * that went backwards would read as the agent losing ground it had already walked. */
    walkMoving: 'Walking to {goal} — {at} of {of}',
    /** When a host reported a journey without saying where it ends, which an older one may. */
    walkSomewhere: 'somewhere',
    /** A destination that names a column rather than a point. */
    walkAnyHeight: '{x}, any, {z}',
    actionsPlacement: 'Placement',
    actionsOpen: 'Open',
    setServerTitle: 'Where should {name} play?',
    setServerHint: 'The account is the same account wherever it joins, so this changes nothing about its credentials.',
    unassignHint: 'Leave blank to take it off its server. It stays set up and can be assigned again later.',
    needsServer: 'Assign a server before connecting.',
    removeTitle: 'Delete {name}?',
    removeWarning: 'The agent is removed from Osmium. Credentials stored on {host} are not affected — revoke the account there if it should stop working.',

    uptime: 'Uptime',
    health: 'Health',
    food: 'Food',
    position: 'Position',
    dimension: 'Dimension',
    /**
     * Keyed by the id a host reports, which is Minecraft's own name with the namespace stripped. A
     * dimension not listed here is humanised from its id rather than dropped — servers run custom
     * worlds, and this list is the vanilla three rather than a closed set.
     */
    dimensions: {
      overworld: 'Overworld',
      the_nether: 'The Nether',
      the_end: 'The End',
    },
    noTelemetry: 'This agent has not reported recently.',
    ping: 'Ping',
    blocksPlaced: 'Blocks placed',
    nearby: 'Nearby',
    noNearby: 'No players in range.',
    activity: 'Activity',
    noActivity: 'Nothing to report.',
    chat: 'Chat',
    chatPlaceholder: 'Send a message as this agent',
    send: 'Send',
    agentTag: 'agent',
  },

  /** A placeholder screen. Nothing is built behind it yet. */
  /**
   * The live world view. Camera words rather than agent words: both modes read the same stream and
   * neither sends anything to the agent, so nothing here says 'control'.
   */
  viewer: {
    title: 'View',
    subtitle: "What this agent can see, as it sees it.",
    orbit: 'Free camera',
    /** Under the name of somebody the stream has dropped, whose body is left where it last was. */
    lastKnown: 'Last known {when}',
    outdated: 'This agent has left the game. What you are seeing is the world as it last was.',
    ours: 'ours',
    firstPerson: 'First person',
    /** The free camera travelling with the agent. Only offered outside first person. */
    follow: 'Follow',
    sendHere: 'Send here',
    connecting: 'Waiting for the world…',
    refused: 'You are not allowed to watch this agent.',
    lost: 'The connection to this agent ended.',
    unreachable: 'Could not open a stream for this agent.',
    broken: 'The renderer could not start: {reason}',
    unsupported: 'This host is streaming a format this page cannot read. Update Osmium.',
    unstaged: "The renderer has no block data for Minecraft {version}. Stage it with OSMIUM_VIEWER_VERSIONS and rebuild.",
    /** The controls, over the bottom left of the view. Keep each one short: they sit on one line. */
    legendOrbit: 'drag to turn',
    legendPan: 'right-drag to pan',
    legendSelect: 'shift-drag or shift-click two blocks to select',
    /** Over the panel an area dragged out in the view opens, above its corners and size. */
    area: 'Area',
    legendZoom: 'wheel to zoom',
    legendFast: 'shift for faster',
    legendFly: 'ctrl to move the pivot',
  },

  /** The agent's own inventory screen, laid out the way Minecraft lays one out. */
  inventory: {
    title: 'Inventory',
    /** Said of the report, not of the agent: it is carrying something, we have not been told what. */
    none: 'The agent has not reported what it is carrying.',
    armour: 'Armour',
    offhand: 'Off hand',
    /** The game's own word for the twenty-seven, which is what an operator will look for. */
    main: 'Inventory',
    hotbar: 'Hotbar',
    /** On the square that is in hand, which the game draws with a highlight rather than a word. */
    held: 'In hand',
    hold: 'Put in hand',
    empty: 'Empty square',
    /** Durability, on the scale the game shows it: what is left, not what is used. */
    durability: '{left} of {max} durability left',
    /** The one instruction the grid needs, and only while there is something to act on. */
    /** In the panel, because it is the one thing the panel itself cannot offer. */
    dragToMove: 'Drag a square onto another to move it.',
    dropOne: 'Drop one',
    dropStack: 'Drop stack',
    /** Why the squares do nothing. Moving an item is a click in a window that needs a session. */
    blockedOffline: 'Not in game, so nothing can be moved.',
    /** Temporary, and the operator's own doing — so it says what to wait for, not what is wrong. */
    blockedBuilding: 'Building. What it is carrying is the build, so nothing can be moved until the segment is done.',
    blockedPermission: 'Moving items needs the same permission as running the agent.',
  },

  map: {
    title: 'Map',
    subtitle: 'Where the fleet is working.',
    empty: 'Nothing here yet.',
    /** Drawn from what agents have walked over, so an empty map means nobody has been there. */
    unmapped: 'No agent has charted a server yet. The map fills in as they move.',
    failed: 'The map could not be drawn: {reason}',
    server: 'Server',
    /** "World", not "Dimension": a server running Multiverse has many, and they are not dimensions. */
    world: 'World',
    goto: 'Go to',
    /** Three numbers is what F3 gives, and pasting it should work; the height is dropped. */
    gotoHint: 'x, z  or  x y z',
    charted: '{count} chunks charted',
    lastSeen: 'Last seen {when}',
    /** Under the pointer, in the coordinates F3 shows. */
    at: '{x}, {z}',
    sendHere: 'Send here',
    /** A click where the fleet has charted nothing, so the height of the ground is unknown. */
    pickUncharted: '{x}, ?, {z}',
    pickNoGround: 'Nobody has walked here, so the agent is sent to this spot at whatever height the ground is.',
    /** Over the panel an area dragged out on the map opens, above its corners and size. */
    area: 'Area',
    /** Under the map's coordinates while nothing is pointed at: how to drag an area out. */
    selectHint: 'shift-drag or shift-click twice to select',
    sendCount: 'Send {count} | Send 1 agent | Send {count} agents',
    scale: '{n} px per block',
    recentre: 'Centre on the fleet',
    agents: 'Agents',
    strangers: 'Other players',
    /** Distance to the closest agent, which is the reading somebody acts on. */
    blocksAway: '{count} blocks from the fleet',
    /** On the scale the game draws them, which is what an operator is comparing against. */
    hearts: '{n}/20 hp',
    food: '{n}/20 food',
    seenBy: 'Nearest to {agent}',
    /**
     * Said under a marker nobody can see any more: an agent that left the game or walked into
     * another world, and a player who went out of the view of every agent. The position is real
     * and it was true when it was taken, which is what makes the time worth saying out loud.
     */
    lastKnown: 'Last known {when}',
    /** Said of the picture, not of any one tile: parts of it may be hours old. */
    stale: 'Terrain is as it was last seen, not as it is now.',
  },

  /** A placeholder screen. Nothing is built behind it yet. */
  /**
   * What each host can route a session through.
   *
   * Read-only on purpose, and the copy says why rather than leaving an operator hunting for an
   * "add" button: a proxy is a file on the machine that dials it, because the password it may need
   * is not something Osmium should be storing, showing or relaying.
   */
  proxies: {
    subtitle: 'Routes the hosts are offering. {count} agents connect from their host directly.',
    empty: 'No host is offering a proxy. Hosts read them from a file of their own and announce them on connect — see the host README.',
    name: 'Name',
    kind: 'Kind',
    address: 'Address',
    routed: 'Agents routed',
    nobody: 'nobody',
    /** On the icon beside a name. What it authenticates *with* never leaves the host. */
    authenticated: 'Needs a password, which stays on the host',
    /** A machine that is not connected is not offering nothing; it is not saying. */
    unheard: 'Not connected',
    stranded: 'is set to route through “{name}”, which this host is not offering. It will refuse to connect rather than go direct.',
  },

  /**
   * Build jobs: a plan frozen and being carried out.
   *
   * The vocabulary is deliberately different from the plan's. A plan is *placed* and *substituted*;
   * a job is *started*, its pieces are *assigned*, and it is *paused* rather than stopped — because
   * a job that has been divided and crewed is something you come back to, not something you throw
   * away. Deleting one is a separate act, and the only one that is final.
   */
  jobs: {
    empty: 'Nothing has been built yet. Start a job from the Schematics tab.',
    subtitle: '{schematic} on {server}',
    startedBy: 'Started by {who}, {at}',
    anchor: 'Anchored at {x}, {y}, {z}',
    placed: '{placed} of {total} blocks',
    waiting: '{count} segment(s) waiting for somebody to build them',
    started: "Building '{name}' in {count} segment(s).",
    pause: 'Pause',
    resume: 'Resume',
    paused: "Paused '{name}'. Its builders stay on it.",
    resumed: "Resumed '{name}'.",
    /** Said on the card, because this is where somebody looks when a bot will not take other work. */
    pausedNote: 'Stopped, and still holding its builders. Resume it, or take them off one at a time.',
    remove: 'Delete',
    removed: "Deleted '{name}'. What it did is still in the audit trail.",
    removeTitle: "Delete '{name}'?",
    /** Said plainly: the counts are the part nothing else keeps. */
    removeWarning: 'The job and every one of its pieces go, along with what each of them reported placing. What the fleet did stays in the audit trail; how far it got does not.',
    segment: 'Segment',
    box: 'From → to',
    blocks: 'Blocks',
    assignee: 'Builder',
    assignTo: 'Assign to…',
    nobodyAvailable: 'Nobody free on this server',
    /** Not the fleet's fault: the piece has nothing under it to stand on yet. */
    assignBlocked: 'Not ready — assign anyway…',
    unassigned: 'Unassigned',
    release: 'Release',
    released: 'Segment {ordinal} goes back to the pool.',

    /**
     * The crew, which is not the same list as the assignees. An agent can be on a build holding
     * nothing, waiting for the floor under its next piece.
     */
    tabPieces: 'Pieces',
    pool: 'Builders',
    poolEmpty: 'Nobody on it yet.',
    poolAgent: 'Agent',
    poolHolding: 'Holding',
    poolBuilt: 'Built',
    poolSince: 'On it since',
    poolSegment: 'Segment {ordinal}',
    /** Idle is ordinary on a job cut on height, so it is worded as waiting rather than as nothing. */
    poolIdle: 'Waiting for a piece',
    /** An agent deleted mid-job keeps its label on what it built. */
    poolGone: 'Deleted',
    poolRemove: 'Take off',
    addAgent: 'Add builders',
    addHint: 'They are given pieces of {name} as those come free. Only agents in game on {server} can be put on it.',
    addSelected: 'Add builders | Add {count} builder | Add {count} builders',
    /** Said of the agents the picker greys out, so "why not that one" is answered in the dialog. */
    pickerUnavailable: 'Not in game, or already on another job.',
    takeOff: 'Take off this job',
    joined: '{count} builder is on the job. | {count} builders are on the job.',

    /** Narrowing a long pieces table. Every question asked of it is a state. */
    filterAll: 'All',
    filterWorking: 'Working',
    filterFree: 'Free',
    filterFailed: 'Failed',
    filterBuilt: 'Built',
    left: '{label} is off the job, and what it held is free again.',
    /** Why a piece nobody holds is not a piece anybody can take. */
    blockedBy: 'Waiting on {ordinals}',
    /** And why one that is ready is still not going to {label}. */
    releasedFrom: 'Taken off {label}, waiting for somebody else',
    assigned: 'Segment {ordinal} assigned.',
    /** What is still missing before a plan can be handed to anybody. */
    needNode: 'You may design a build but not dispatch the fleet.',
    needPlan: 'Save a plan first — a build needs somewhere to stand.',
    needPlacement: 'Place the plan before building it.',
    state: {
      ACTIVE: 'Building',
      PAUSED: 'Paused',
      DONE: 'Built',
    },
    /**
     * Per segment. 'Assigned' and 'Building' are separate words even though nothing dispatches yet:
     * the day a host can be sent work, the difference between having been given a piece and having
     * started it is the first thing an operator will look for.
     */
    segmentState: {
      PENDING: 'Free',
      ASSIGNED: 'Assigned',
      BUILDING: 'Building',
      DONE: 'Built',
      FAILED: 'Failed',
    },
  },
  operations: {
    title: 'Operations',
    subtitle: 'Run work across the fleet.',
    empty: 'Nothing here yet.',
    agents: 'Agents',

    /** The three things this screen does, as tabs. Nouns: they are places, not commands. */
    tabSchematics: 'Schematics',
    tabJobs: 'Jobs',
    tabFleet: 'Servers & connections',

    /** One panel now, because setting a fleet up is all three of these in a row. */
    fleetTitle: 'Act on the selected agents',
    serverMode: 'Server',
    hint_connect: 'Brings the selected agents into the game, one at a time. A refusal stops the run rather than leaving an unpredictable half of it done.',
    hint_disconnect: 'Ends the session of every selected agent. What they were building is released and can be picked up again.',
    hint_server: 'Points every selected agent at one Minecraft server. Credentials are untouched — an account is the same account wherever it joins.',
    /** The button says what it will do and to how many: the number worth checking before pressing. */
    connectCount: 'Connect {count} agent | Connect {count} agents',
    disconnectCount: 'Disconnect {count} agent | Disconnect {count} agents',
    assignCount: 'Assign {count} agent | Assign {count} agents',
    pickAgents: 'Select the agents to change.',
    applying: 'Applying…',
    /** These run one at a time and reach real servers, so which one matters more than that it is busy. */
    applyingOne: 'Applying {done} of {total}…',
    /**
     * A run that stopped part way. Both halves are said: what already took effect, and why the rest
     * did not — reporting only the failure left the fleet in a state nobody could read off the screen.
     */
    stoppedAfter: 'Stopped at {name} after {count} went through — {reason}',
    clearServer: 'Take off server',
    assigned: 'Assigned {count} agents to {server}.',
    cleared: 'Took {count} agents off their server.',
    onlineExcluded: 'Online agents cannot be moved. Disconnect them first.',

    connect: 'Connect',
    disconnect: 'Disconnect',
    connected: 'Connected {count} agents.',
    disconnected: 'Disconnected {count} agents.',
    offlineOnly: 'Already online, or already connecting.',
    onlineOnly: 'Not in game.',

    /** Read aloud in place of the box picture, so it says the size rather than the angle. */
    boxSize: '{name} {x} by {y} by {z} blocks',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetView: 'Reset the view',
  },

  schematics: {
    title: 'Schematics',
    step_schematic: 'Schematic',
    step_plan: 'Plan',
    step_agents: 'Agents',
    step_split: 'Split',
    back: 'Back',
    next: 'Next',
    needSchematic: 'Choose a schematic that has been read.',
    needBuilders: 'Choose the agents that will build it.',
    uploadTitle: 'Upload a schematic',
    uploadIntro: 'A .litematic or .schem. It is read once it arrives, which takes a while on a large one — the list shows how far along it is. The format is taken from the file, not its name.',
    buildTitle: 'What is being built',
    buildingWhat: 'Building',
    blocksEach: 'each',
    /**
     * Named when the plan and the file disagree. A total that silently shrank would read as a
     * miscount rather than as the substitutions the operator asked for one step ago.
     */
    afterSubstitutions: 'After {plan}: {omitted} blocks are left out.',
    /** Which coordinate space the split is drawn in — "is this where I fly to" has no other answer. */
    worldCoords: 'World coordinates, as placed by {plan}',
    fileCoords: "The schematic's own coordinates — nothing has placed it yet",
    startBuilding: 'Start building',
    subtitle: 'What the fleet builds from.',
    empty: 'No schematics yet. Upload a .litematic or .schem to start.',
    filterPlaceholder: 'Search schematics',
    noMatches: 'Nothing matches that.',
    upload: 'Upload',
    uploading: 'Sending… {sent} of {total} · {percent}%',
    /**
     * Sending again starts a new schematic rather than resuming this one, so the abandoned row is
     * named: it is in the library, and nothing else on screen connects it to the cancel just pressed.
     */
    cancelledAt: 'Cancelled after {sent}. The part that arrived is kept as an unfinished schematic in the library — send again to start over, and delete that one when you no longer want it.',
    cancel: 'Cancel',
    namePlaceholder: 'Name this schematic',
    name: 'Name',
    deleteTitle: 'Delete {name}?',
    /** The one act on this tab whose outcome is not visible where it happened: the row just goes. */
    deleted: 'Deleted {name}.',
    deleteWarning: 'The file goes with it, and so does everything measured from it — the material list, the shape, any division worked out from it. Anything already being built carries on.',
    pickFile: 'Choose a file',
    rename: 'Rename',
    delete: 'Delete',
    selectHint: 'Select a schematic to see its shape.',

    /** The row's own state, which is a two-stage bar: bytes arriving, then bytes being read. */
    statusUPLOADING: 'Uploading',
    statusPENDING: 'Queued',
    statusANALYSING: 'Reading',
    statusREADY: 'Ready',
    statusFAILED: 'Failed',

    /**
     * How far into that state, under the bar. The badge says which stage; these say how much of it
     * is left, which for a queued schematic is the only thing that was ever missing.
     */
    progressUploading: '{sent} of {total} · {percent}%',
    progressWaiting: 'Waiting to be read',
    progressNext: 'Next to be read',
    progressQueued: 'Waiting · {ahead} ahead of it',
    progressReading: '{percent}% · pass {pass} of 2',

    blocks: 'Blocks',
    volume: 'Volume',
    regions: 'Regions',
    size: 'Size',
    format: 'Format',
    materials: 'Materials',
    noMaterials: 'Nothing to gather.',
    dragHint: 'Drag to turn. Arrow keys work too.',
    reread: 'Re-read',
    rereadHint: 'Reads the uploaded file again, without sending it again.',
    viewShape: 'Shape',
    detail: 'Detail',
    viewBounds: 'Bounds',
    /** Beside the slider, where the width has to be the same at every position. */
    detailAcross: '{count} across',
    shapeExact: 'One voxel per block.',
    shapeCoarse: 'One voxel per {size} blocks — a massing model, not a picture.',
    shapeOf: 'A model of a build {x} by {y} by {z} blocks',
    uploadedBy: 'Uploaded by {name}',
    builders: 'Agents',
    buildingOn: 'Building on',
    pickBuilders: 'Select the agents that will build it.',
    /** Every reason at once: a per-agent one is the dot and the tooltip beside each row. */
    cannotBuild: 'These cannot build it: not in game, already on a job, or on another server.',
    splitBetween: 'Split into {count}',
    /** Pieces, which stopped being the same number as agents when agents became a pool. */
    parts: 'Pieces',
    partsDefault: 'One each ({count})',
    partsQueue: '{parts} pieces for {agents} agents — they take the next one as they finish.',
    splitTitle: 'Divide between agents',
    splitting: 'Dividing…',
    mode: 'How to cut it',
    modeCOLUMNS: 'Columns',
    modeGRID: 'Grid',
    modeHintCOLUMNS: 'Full-height pieces of the footprint. Every agent has its own ground and builds bottom-up without waiting for anyone.',
    modeHintGRID: 'Cuts on any axis, wherever the blocks balance. Pieces at one height go out together; the ones above them wait for a floor.',
    segment: 'Segment {ordinal}',
    segmentShare: '{blocks} blocks · {percent}%',
    splitShort: 'This divides into {parts} of the {requested} asked for. There is not enough of it to go further.',
    splitNotReady: 'Wait for the schematic to be read.',
    outdated: 'Older Minecraft',
    outdatedHint: 'Saved from Minecraft data version {version}, which is older than the one this fleet builds. Most blocks are unchanged between versions, but any that were renamed will fail when an agent tries to place one — check the material list below.',
  },

  /** MOCK, pending the backend. The field list here is a placeholder, not a specification. */
  configuration: {
    title: 'Configuration',
    subtitle: 'Configure agents without touching the machines they run on.',
    agents: 'Agents',
    selectAll: 'Select all',
    /** Named for what it takes: under a search, the rows on screen and not the whole fleet. */
    selectAllShown: 'Select all shown',
    filterAgents: 'Search agents',
    noMatches: 'No agents match that.',
    noAgents: 'No agents yet.',
    pickOne: 'Select an agent to see its settings.',
    selected: '{count} selected',
    valuesFrom: 'Showing {name}’s settings.',
    appliesTo: 'Applies to {count} agent | Applies to {count} agents',
    update: 'Update this tab',
    updating: 'Sending…',
    updated: 'Settings sent to {name}.',
    updatedMany: 'Settings sent to {count} agents.',
    unsaved: 'Unsaved changes.',
    /** Update sends the tab on screen, so anything edited behind it has to say so. */
    unsentElsewhere: 'Also edited, and not sent: {tabs}.',
    reset: 'Discard changes',
    /**
     * Kept whether or not the host is reachable — configuration is a preference, not an action, and
     * an unreachable host is sent it when it comes back.
     */
    offlineNote: 'Saved even when a host is unreachable. It is sent when the host reconnects.',

    groups: {
      chat: 'Chat',
      mc: 'Minecraft',
      util: 'Utility modules',
      path: 'Movement',
      connect: 'Connection',
      players: 'Players',
    },

    /** The list editor itself, shared by every `players` field. */
    players: {
      add: 'Add a player',
      remove: 'Remove {name}',
      empty: 'Nobody yet, so this agent takes no chat commands at all.',
      notAName: 'Minecraft names are letters, digits and underscores, up to sixteen.',
      alreadyThere: 'Already on the list.',
      /**
       * Named situations rather than a general warning. Osmium identifies a speaker from the chat
       * format it was given, because a server that reformats chat sends no sender at all — so the
       * name is reconstructed, never verified.
       */
      disclaimer: 'WARNING: Osmium reads these names out of chat, it cannot prove them. A server that allows nicknames, or one in offline mode, can put anybody behind a trusted name — and a wrong chat format can too. Only grant Commands where you would hand over the account.',
      trust: 'What this player may do',
      /** Cumulative, and said so: the higher tier is the lower one plus the ability to act. */
      chat: 'Chat',
      pickTitle: 'Commands',
      pickHint: 'Exactly what is ticked, and nothing else. Anything unticked is silently refused in game.',
      pickAll: 'All',
      pickNone: 'None',
      elevated: 'Elevated',
      count_commands: 'no commands | 1 command | {count} commands',
      unknownCommand: 'Kept from a newer Osmium:',
      /** Each command, as it reads to somebody deciding whether to grant it. */
      command: {
        id: 'Says which agent it is',
        ping: 'Reports its round trip to the server',
        health: 'Reports its health',
        food: 'Reports its hunger',
        uptime: 'Reports how long it has been connected',
        '8ball': 'Answers a yes-or-no question like a Magic 8-Ball',
        cf: 'Flips a coin',
        roll: 'Rolls a die, six-sided or with as many sides as asked',
        say: 'Makes the agent speak in chat',
        help: 'Lists the commands the asker may use',
        goto: 'Sends the agent to coordinates, or stops it with goto stop',
        run: 'Runs a server command as the agent — close to handing over its account',
        disconnect: 'Disconnects the agent and stops it rejoining',
        reconnect: 'Reconnects the agent',
      },
      commands: 'Chat & Commands',
      count: '{count} player | {count} players',
    },

    /**
     * Keyed by setting, with the dots replaced — a key like `chat.sender` would otherwise nest
     * itself into the message tree and stop resolving.
     */
    settings: {
      chat_sender: {
        label: 'How this server names the speaker',
        hint: 'Servers that reformat chat send one rendered line with no marker for who spoke, so the name is read back out of it. The capture group is the player name. Leave this empty for a vanilla server.',
      },
      chat_whisper: {
        label: 'How this server writes a whisper',
        hint: 'A whisper is chat addressed to this agent rather than to the room, and it appears in the agent’s own tab instead of the server’s. Matched against messages sent to the agent; the capture group is who sent it.',
      },
      chat_whisperSent: {
        label: 'How this server writes a whisper the agent sent',
        hint: 'The other direction: a private message this agent sent, coming back from the server. Without it an operator’s own whisper returns unattributable and reads as the server talking. The capture group is who it went to.',
      },
      chat_whisperCommand: {
        label: 'How to send a private message',
        hint: 'The command the agent uses to whisper somebody back — a command asked privately is answered privately. {name} and {message} are filled in. Leave empty for /msg, which most servers accept.',
      },
      mc_version: {
        label: 'Minecraft version',
        hint: 'Leave empty to ask the server, which is right almost always. Set it for a server that refuses a version check or answers one dishonestly — behind a proxy, or with bot protection in front. Applies from the next connect.',
      },
      util_autoEat: {
        label: 'Auto eat',
        hint: 'Eats before hunger stops health regenerating, and reaches for a golden apple when badly hurt rather than for a snack. The agent stands still for the meal and goes back to what it was holding and doing.',
        options: {
          auto: 'Off',
          on: 'On — eat what it carries',
          dupe: 'Restock — /dupe when it runs low',
        },
      },
      util_autoTotem: {
        label: 'Auto totem',
        hint: 'Keeps a totem of undying in the off hand, refilled the moment one pops rather than on a timer.',
        options: {
          auto: 'Off',
          on: 'On — use what it carries',
          dupe: 'Restock — /dupe when it runs low',
        },
      },
      util_fleeDistance: {
        label: 'Flee from strangers',
        hint: 'Leaves the server, and raises an alert, when a player who is not on the trust list comes within this many blocks. Blank is off. The agent stays out afterwards rather than reconnecting into whoever it just left. Your other agents are strangers unless you list them.',
      },
      util_antiHunger: {
        label: 'Anti hunger',
        hint: 'Hunger is charged by how far the agent moves and how fast. Careful gives up sprinting, which is honest and simply slower. Spoof keeps the speed and does not declare the sprint, which the server can see for itself — an anticheat that compares movement against declared state has everything it needs.',
        options: {
          auto: 'Off',
          careful: 'Careful — never sprint',
          spoof: 'Spoof — sprint undeclared',
        },
      },
      path_range: {
        label: 'Search distance',
        hint: 'How far from the agent a route may be searched for, in blocks. A search cannot see past the chunks the server has sent — a dozen wide at most — so a larger number does not find longer routes, it spends the search on ground the host has not got. Long journeys are walked as a run of short ones. Default 128.',
      },
      path_mode: {
        label: 'Getting around',
        hint: 'Walk, or fly where the server lets the agent fly - creative mode, or a server that allows flight. A flying agent goes straight where the air is clear and around what is in the way where it is not, then lands. Where flying is not allowed, or the air has no way through, it walks instead and says so in its activity.',
        options: {
          auto: 'Walk',
          fly: 'Fly',
        },
      },
      path_flyCommand: {
        label: 'Command to allow flight',
        hint: 'Run in game when the server has not let the agent fly yet — /fly on servers that grant flight that way. Only run when flying is not already allowed, because most of these switch flight off as well as on. If the server still has not allowed it a few seconds later, the agent flies anyway when the switch below is on, and walks otherwise.',
      },
      path_flySpeed: {
        label: 'Flying speed',
        hint: 'Multiplies how fast the agent flies and climbs. Unset is ×1, the server\'s own flying speed. Faster covers ground sooner and is easier for anti-cheat to notice, especially with forced flight.',
        low: 'Slower',
        high: 'Faster',
      },
      path_forceFly: {
        label: 'Fly even where not allowed',
        hint: 'Flies on servers that do not allow it, by dipping now and then so the server does not kick for floating, and by claiming to stand on the ground so the landing costs nothing. Anti-cheat plugins catch it, and some ban for it.',
      },
      path_dig: {
        label: 'May dig',
        hint: 'Lets the agent break blocks to get through rather than walking around. Faster, and it changes somebody else\'s world: a route that saves nine blocks by tunnelling through a wall leaves the wall with a hole in it. Off, a route that needs digging is simply not found.',
      },
      path_bridge: {
        label: 'May bridge',
        hint: 'Lets the agent place blocks from its own inventory to cross a gap or pillar up. Only what it is carrying, so an empty inventory is the same as this being off — and what it places stays where it put it.',
      },
      path_parkour: {
        label: 'May jump gaps',
        hint: 'Lets the agent take running jumps across gaps of up to four blocks instead of going round. Quicker and less reliable: a missed jump is a fall, and a fall near lava or a ravine is the end of the session.',
      },
      path_maxDrop: {
        label: 'Longest drop',
        hint: 'The furthest the agent will step off, in blocks. Four is where fall damage starts, so the default of three is the drop that costs nothing. Higher trades health for shorter routes.',
      },
      path_haste: {
        label: 'Route quality',
        hint: 'How far the search may trade a shorter route for finding one sooner. Towards the shortest route, the agent takes the most direct line the rules allow however long that takes to work out; towards the fastest search, it commits sooner and the route can wander. Long bridges and towers are where this matters most, because the search is slowest across ground the agent cannot walk. The middle is how agents have always planned.',
        low: 'Shortest route',
        high: 'Fastest search',
      },
      util_noFall: {
        label: 'No fall',
        hint: 'Claims to be standing on the ground while falling, so the landing costs nothing. Only while a fall is far enough along to hurt. This tells the server something untrue and is what anticheat plugins look for — a ban is the one thing here that cannot be undone.',
      },
      mc_takeKnockback: {
        label: 'Anti knockback',
        hint: 'Hits, explosions and anything else that shoves move a player. On, the agent stands exactly where it is — useful for a builder that must not be nudged off a scaffold, and conspicuous on a server that watches for it.',
        options: {
          auto: 'Off — pushed like a player',
          false: 'On — never moved',
        },
      },
      mc_knockback: {
        label: 'Knockback correction',
        hint: 'Recent versions send velocity in a unit the library still scales as if it were the old one, so agents cannot be pushed by hits, explosions or boats. Decided from the version unless the version is not the whole story — a proxy can forward a different one than it advertises.',
        options: {
          auto: 'When the version needs it',
          true: 'Always',
          false: 'Never',
        },
      },
      players_whitelist: {
        label: 'Trusted players',
        hint: 'Who may command this agent from in game, with !osm. Empty means nobody. Chat lets somebody make the agent talk and identify itself; Commands also lets them run server commands through it, under whatever permissions its Minecraft account holds — on an operator account that is close to handing it over.',
      },
      connect_proxy: {
        label: 'Route through',
        hint: "Sends this agent's connection through one of its host's proxies, so the server sees the proxy's address instead of the machine's. The list is what that host holds; the address and any password stay on it, and Osmium never learns them. An agent naming a proxy its host does not have refuses to connect rather than going direct.",
        /** The empty option. Not "off": nothing is being turned off, the traffic simply goes as it is. */
        direct: 'Directly, from the host',
        /** When the selection spans hosts, a proxy is named with the machine that holds it. */
        onHost: '{name} — {host}',
        /** Said in place of the picker when nothing can be picked. */
        none: 'No host in this selection is holding any proxies.',
      },
      connect_rejoin: {
        label: 'Rejoin automatically',
        hint: 'Puts the agent back after a kick, a server restart or a host reboot, waiting longer between each try. Only after somebody has connected it: an agent you disconnected stays out. Gives up after about half an hour and says so in its activity.',
      },
    },

    /** The box itself: what is wrong with a pattern, or what it does to a real line. */
    regex: {
      invalid: 'That is not a valid pattern.',
      noCapture: 'This matches, but captures nothing — so it can never name a player. Put brackets around the name.',
      reads: 'Reads “{name}” from “{sample}”.',
      noMatch: 'Does not match “{sample}”.',
      useDefault: 'Use the vanilla format',
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
    /**
     * Shown on the login screen, which is otherwise exactly what success looks like. The distinction
     * matters most to the person who pressed this because they believed they were compromised.
     */
    endAllFailed: 'This browser was signed out, but Osmium could not confirm the other sessions were ended. Treat them as still active and try again once you are signed back in.',
    failed: 'Could not end that session.',

    /**
     * Says what happened and what to do, and stops there. The signal is "a token was presented
     * twice", which is usually theft and is not proof of it — copy that asserted an attack would be
     * claiming more than the system knows, and would read as crying wolf the first time it was
     * something duller.
     */
    alertTitle: 'A sign-in token for your account was used twice',
    alertBody: 'That normally means a copy of it exists somewhere it should not, so every session was signed out on {when}. If this was not you, change your password.',
    alertDismiss: 'Dismiss',
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
    passwordResetWarning: 'Setting a password also ends every session that account has.',
    signOut: 'Sign out everywhere',
    signOutTitle: 'Sign {name} out of every session?',
    signOutWarning: 'Every browser signed in as {name} is signed out, and access already granted stops working immediately. The account itself is untouched and they can sign in again.',
    removeTitle: 'Delete {name}?',
    /**
     * Says what survives as well as what does not. The audit trail outliving its subject is the
     * whole reason entries carry a name rather than a foreign key.
     */
    removeWarning: 'The account and its sessions are gone for good, and anyone signed in as it stops working at once. What they already did stays in the audit trail. This cannot be undone.',
    removeAction: 'Delete account',
    removing: 'Deleting…',
    signedOut: '{name} has been signed out everywhere.',
  },

  /**
   * The storage screen.
   *
   * The copy carries one idea the interface cannot show on its own: deleting and reclaiming are two
   * different things, and only the second makes the disk smaller. Every string that touches a size
   * is written to keep that distinction rather than to be brief about it.
   */
  storage: {
    title: 'Storage',
    subtitle: 'What Osmium is keeping on disk, and how to keep less of it.',
    database: 'Database',
    /** The areas add up to less than the database: the catalogue and free pages are the rest. */
    accounted: '{size} across the areas below',
    reclaimable: 'Freed, not returned',
    reclaimableNote: 'Approximate. Deleted rows the tables have kept.',
    byArea: 'By area',
    /** The bar's axis, said once above the list rather than guessed at per row. */
    shareNote: 'The bar is each area’s share of everything stored.',
    /** An estimate from Postgres, which is why it is never presented as a count. */
    rows: 'about {n} rows',
    since: 'oldest {when}',
    dead: '{size} freed',
    purge: 'Delete',
    purging: 'Deleting…',
    keptAudit: 'Kept: this is the record',
    keptElsewhere: 'Managed on its own page',
    /** Nothing is stored; the disk simply has not been handed back yet. */
    emptied: 'Nothing stored — awaiting reclaim',

    purgeTitle: 'Delete {area}',
    keep: 'Keep the last',
    keepHint: 'Days. Zero deletes everything in this area.',
    purgeOlder: 'Everything older than {days} days goes. This cannot be undone.',
    purgeAll: 'Every {area} record goes. This cannot be undone.',
    /** The part that surprises people, said before the button rather than after. */
    purgeNote: 'The space is freed inside the database, not on the disk. Returning it to the disk is the step below.',

    reclaimTitle: 'Return freed space to the disk',
    reclaimBody:
      'Deleting rows leaves the space inside the tables, which keep it and reuse it. Rewriting the tables hands it back to the operating system.',
    reclaimAction: 'Reclaim space',
    reclaiming: 'Reclaiming…',
    reclaimConfirm: 'About {size} should come back.',
    /** The cost, plainly: this is why it is not something a delete does on its own. */
    reclaimLock: 'Every table is locked while it is rewritten. Hosts cannot report and pages will not load until it finishes.',

    areas: {
      CHAT: 'Chat',
      ACTIVITY: 'Activity',
      MAP: 'Map',
      /** Where each person was last seen, which is what the map draws in grey. */
      POSITIONS: 'Last known positions',
      AUDIT: 'Audit trail',
      SCHEMATICS: 'Schematics',
      BUILDS: 'Builds',
      FLEET: 'Hosts and agents',
      ACCOUNTS: 'Accounts and sessions',
      OTHER: 'Everything else',
    },
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

  /** The lifecycle of an agent, as an operator reads it. */
  agentState: {
    ONLINE: 'Online',
    LINKED: 'Ready',
    CONNECTING: 'Connecting',
    UNLINKED: 'Not set up',
    SETUP_PENDING: 'Setting up',
    NEEDS_RELINK: 'Needs sign-in',
    CONNECT_FAILED: 'Connection failed',
    STALE: 'Unknown',
    /**
     * Not a state the backend has. Shown in place of ONLINE for an agent holding a piece of a run,
     * because building already says in game and the more specific fact is the useful one.
     */
    BUILDING: 'Building',
  },

  auditAction: {
    AGENT_CREATE: 'Agent created',
    AGENT_UPDATE: 'Agent edited',
    AGENT_DELETE: 'Agent deleted',
    AGENT_SETUP: 'Set up',
    AGENT_SETUP_CANCEL: 'Setup abandoned',
    AGENT_CONNECT: 'Connect',
    AGENT_DISCONNECT: 'Disconnect',
    AGENT_CHAT: 'Chat',
    AGENT_INVENTORY: 'Items moved',
    AGENT_PATH: 'Sent somewhere',
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
    STORAGE_PURGE: 'Storage cleared',
    SESSION_REUSE_DETECTED: 'Session token replayed',
    SESSION_REVOKED_ALL: 'Signed out everywhere',
    SCHEMATIC_UPLOAD: 'Schematic uploaded',
    SCHEMATIC_RENAME: 'Schematic renamed',
    SCHEMATIC_DELETE: 'Schematic deleted',
    BUILD_CREATE: 'Build planned',
    BUILD_UPDATE: 'Build plan changed',
    BUILD_DELETE: 'Build plan deleted',
    BUILD_JOB_START: 'Build started',
    BUILD_JOB_PAUSE: 'Build paused',
    BUILD_JOB_RESUME: 'Build resumed',
    BUILD_JOB_DELETE: 'Build record deleted',
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
    'user.sessions.revoke': 'Sign an account out everywhere',
    'role.read': 'View roles',
    'audit.read': 'View the audit log',
    'audit.export': 'Export the audit log',
    'agent.read': 'View agents and telemetry',
    'host.read': 'View hosts',
    'activity.read': 'View agent activity',
    'chat.read': 'Read in-game chat',
    'chat.speak': 'Speak in game as an agent',
    'agent.run': 'Connect and disconnect agents',
    'agent.write': 'Create, rename and place agents',
    'agent.delete': 'Delete agents',
    'agent.setup': 'Set an agent up to log in',
    'host.write': 'Enrol and rename hosts',
    'host.token': 'Rotate a host enrolment token',
    'host.delete': 'Remove hosts',
  },

  /** Where a build stands and what it is built out of. Both belong to a plan, not to the file. */
  builds: {
    title: 'The plan',
    whichPlan: 'Which plan',
    /**
     * The row beside the selector is how a second plan gets made, so a plan being written is in the
     * list too — the control never claims the operator is editing something they are not.
     */
    newPlanOption: 'New plan (unsaved)',
    newPlan: 'Start another plan for this schematic',
    rename: 'Rename this plan',
    renameTitle: 'Rename plan',
    renameHint: 'Only a label. Where the build stands and what it is made of are unchanged.',
    planName: 'Plan name',
    removePlan: 'Delete plan',
    removeTitle: 'Delete {name}?',
    removeWarning: 'The placement and every substitution in it go with it. The schematic itself is untouched, and any other plan for it carries on.',
    placement: 'Placement',
    placementHint: 'Where the schematic’s lowest corner lands. Leave these empty to decide later.',
    unplaced: 'Not placed yet.',
    offsetBy: 'Everything shifts by {x}, {y}, {z}.',
    substitutions: 'Substitutions',
    substitutionsHint: 'Build a block out of something else. Leave the replacement empty to leave it out entirely.',
    addSubstitution: 'Add a substitution',
    placeNothing: 'leave it out',
    inThisBuild: 'in this build',
    createPlan: 'Save plan',
    save: 'Save changes',
    saving: 'Saving…',
    /** Named, because one schematic can carry several plans and a bare tick would not say which. */
    savedAs: 'Saved to {name}',
    unsaved: 'Unsaved changes',
    asBuilt: 'What it comes to',
    blocksPlaced: 'Blocks placed',
    leftOut: 'Left out',
    mergedFrom: 'includes {from}',
    omittedFrom: 'not placed',
  },

  errors: {
    loadSessions: 'Could not load your sessions.',
    assignServer: 'Could not change the server.',
    generic: 'Something went wrong.',
    /**
     * The guard sends anyone without a route's node to the dashboard. Doing that in silence made a
     * bookmarked link read as broken rather than as restricted.
     */
    deniedRoute: 'That page needs {node}, which your role does not have — so this is where you landed instead.',
    unreachable: 'Cannot reach Osmium',
    invalidCredentials: 'Incorrect username or password.',
    loginFailed: 'Could not sign in.',
    passwordMismatch: 'The passwords do not match.',
    pickHost: 'Pick a host to run this agent.',
    commandFailed: 'The command failed.',
    loadHosts: 'Could not load hosts.',
    loadAgents: 'Could not load agents.',
    loadAudit: 'Could not load the audit log.',
    loadDashboard: 'Could not load the dashboard history.',
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
    cancelSetup: 'Could not stop waiting on the setup.',
    connectAgent: 'Could not connect.',
    disconnectAgent: 'Could not disconnect.',
    sendMessage: 'Could not send the message.',
    loadInventory: 'Could not read what the agent is carrying.',
    loadPaths: 'Could not read where the fleet is going.',
    sendTo: 'Could not send the agent there. | Could not send 1 agent. | Could not send {count} agents.',
    stopPath: 'Could not stop the agent.',
    loadStorage: 'Could not read what is stored.',
    purgeStorage: 'Could not delete that data.',
    reclaimStorage: 'Could not return the space.',
    moveItem: 'Could not move the item.',
    dropItem: 'Could not drop the item.',
    holdItem: 'Could not change what the agent is holding.',
    itemIcons: 'Item icons are unavailable, so squares are drawn without them.',
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
