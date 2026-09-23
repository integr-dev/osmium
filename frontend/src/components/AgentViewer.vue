<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, Footprints, LocateFixed, Orbit, TriangleAlert } from 'lucide-vue-next'

import { api } from '../api/client'
import { isOnline, useAgentStore } from '../stores/agents'
import { Emitter, FrameError, readFrame, type ViewerEvent } from '../lib/viewerStream'
import { agentDetail, playerVitals } from '../lib/vitals'
import { skinFor, type Skin } from '../lib/skins'
import ActionMenu from './ActionMenu.vue'
import AgentTargets from './AgentTargets.vue'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toasts'
import { atTime } from '../lib/time'
import { dollyToward, easeZoom, panRate, wheelTurn, zoomFactor, type Point } from '../lib/orbit'
import { axisCross, cornerArms } from '../lib/reticle'
import { cubeEdges } from '../lib/area'
import { buildBoxes, type PlacedBox } from '../lib/buildBoxes'
import { JOB_FALLBACK, JOB_TYPES, jobInk } from '../lib/jobKinds'
import type { JobType } from '../api/jobs'
import { onThemeChange, themeColour as tokenColour } from '../lib/theme'

/**
 * An agent's world, rendered live.
 *
 * The renderer is prismarine-viewer's own, unmodified: writing one would mean reimplementing
 * Minecraft's block models, and upstream has already done it. What Osmium supplies is the transport
 * - upstream talks socket.io straight to a host, and Osmium's hosts dial out and are never
 * reachable - and the assets, which `scripts/viewer-assets.mjs` stages under `/viewer/`.
 *
 * Three small accommodations are needed to point upstream's renderer at those assets, and all three
 * are here rather than in a fork. See {@link mount}.
 */
const props = defineProps<{ agentId: number }>()

const { t } = useI18n()
const agentStore = useAgentStore()
const auth = useAuthStore()
const toasts = useToastStore()

/** The agent as the fleet knows it, which is how this screen learns it has left the game. */
const agent = computed(() => agentStore.byId(props.agentId))

/**
 * A world nobody is in any more.
 *
 * The last frames stay on screen deliberately - blanking them would throw away the only picture of
 * where the agent was when it went - but they stop being true the moment it leaves, and saying so
 * is the difference between a record and a lie.
 */
const stale = computed(() => agent.value !== undefined && !isOnline(agent.value))

/** What the fleet last heard about the people around it, for the labels over their heads. */
const nearby = computed(() => agent.value?.telemetry?.nearby ?? [])

const canvas = ref<HTMLCanvasElement>()
/** Free orbit, or looking through the agent's own eyes. Purely a camera choice: both read the same
 * stream, and neither sends anything to the agent. */
const firstPerson = ref(false)

/**
 * Whether the free camera travels with the agent.
 *
 * Only meaningful outside first person, where the camera already *is* the agent. On, the orbit keeps
 * whatever angle and distance somebody dragged it to and the whole arrangement moves - which is what
 * makes an agent walking four hundred blocks watchable without a hand on the mouse.
 */
const follow = ref(false)

/**
 * How far a drag moves what is under the cursor, as a share of the distance it moves.
 *
 * One, which is the whole of it: drag a hundred pixels and the ground under the pointer travels a
 * hundred pixels. That is only a number worth writing down now that {@link panRate} measures the
 * rate against what is being looked at - it used to be 1.6, which was a guess at how much of
 * upstream's under-scaling to undo, and it was a different guess at every distance.
 */
const PAN_SPEED = 1

/**
 * How big the gimbal cross is, in blocks.
 *
 * **A size in the world, not on the screen.** The pivot is a place, and a mark that stays the
 * same size in the corner of the view whatever the camera does reads as part of the interface -
 * something painted on the glass. One block wide, drawn against a world made of blocks, reads as
 * a thing sitting on the one it is pivoting on: it grows as the camera closes on it and shrinks
 * as it pulls away, which is how you can tell at a glance how far off it is.
 */
const GIMBAL_SPAN = 1

/**
 * How long the gimbal stays up after the camera stops being moved, in milliseconds.
 *
 * **Shown while it is being used and not otherwise**, which is what every tool that draws one
 * does. A pivot marker parked on the screen is one more thing in a view already full of boxes,
 * and the moment it is worth seeing is the moment the view is swinging around it.
 */
const GIMBAL_LINGER = 1600

/** How long it takes to fade out once that has run out. */
const GIMBAL_FADE = 450

/**
 * How much of the pivot mark is left where the world is in front of it.
 *
 * Under half. The dashed half is there to say "it is over there, behind this" - enough to follow
 * and not enough to be mistaken for the thing itself, which is the solid one.
 */
const GHOST_SHARE = 0.45


/**
 * How smoothly the camera catches up with the mouse, as a share of the gap it closes a frame.
 *
 * Damping is most of what separates a viewer that feels like a tool from one that feels like a
 * slider: a drag that stops dead the instant the button comes up reads as a stutter, and one that
 * coasts to a halt reads as weight. An eighth is a couple of frames of coast at sixty a second.
 */
const SETTLING = 0.12

/** Which mouse button pans. The middle one orbits and the left one picks; this is the right. */
const PANNING = 2

/** The left button, which pans while a modifier is held and orbits otherwise. */
const TURNING = 0
const status = ref<'connecting' | 'watching' | 'failed'>('connecting')
const failure = ref('')

/** Held outside Vue's reactivity: three.js objects are large, cyclic graphs and proxying them is
 * both pointless and slow. */
const scene = shallowRef<Scene>()

interface Scene {
  viewer: ViewerLike
  emitter: Emitter
  socket: WebSocket
  renderer: {
    setSize(w: number, h: number, updateStyle?: boolean): void
    render(s: unknown, c: unknown): void
    dispose(): void
    forceContextLoss(): void
  }
  /** Watches the canvas, not the window - see {@link resize}. */
  watcher?: ResizeObserver
  /** The one material every player's box shares; its width is in pixels, so it tracks the canvas. */
  /** One per colour. Each is told the canvas size, because a line width is in pixels. */
  outlineMaterials?: Array<{ resolution: { set(width: number, height: number): void } }>
  /**
   * The single markers - the hover cursor, the gimbal, the block a job is about.
   *
   * Held for one reason: a {@link LineMaterial} width is in pixels, so every one of them has to
   * be told how many there are - see {@link resize}. The outlines and the route were in that list
   * and these three were not, so opening the chat rail left them drawn at the width the canvas
   * used to be.
   */
  markerMaterials?: Array<{ resolution: { set(width: number, height: number): void } }>
  controls?: { enabled: boolean; update(): void; dispose(): void; target: { set(x: number, y: number, z: number): void } }
  frame: number
  position?: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number }
  /** Entity types the renderer can build a mesh for - see {@link buildableModels}. */
  models: Set<string>
  /** Entities ruled out at spawn, so their movements can be dropped too. */
  undrawable: Set<number>
  /**
   * Players the stream has dropped, and when it dropped them.
   *
   * Their bodies are still in the scene, standing where they last were: an id in here is one whose
   * removal was never passed on to the renderer - see {@link apply}.
   *
   * **Nothing here expires.** A body stands until the stream ends or until the id is reused, the
   * same rule the stored record follows: a last known position is worth exactly as much an hour
   * later as it was a minute later, and a viewer that quietly forgot one would be a viewer that
   * disagreed with the map.
   */
  ghosts: Map<number, number>
  /** Faces cut out of skins, by account, for the icon on a nametag. Null once none is coming. */
  heads: Map<string, HTMLCanvasElement | null>
  /**
   * The three box colours as CSS, resolved once with the materials themselves.
   *
   * A canvas cannot be handed a `THREE.Color`, and the face on a label is outlined in the same
   * colour as the box around the body - so both have to come out of the same resolution of the
   * same tokens, or the two would disagree about what "ours" looks like.
   */
  tones: Record<Tone, string>
  /**
   * Resolves every theme colour the scene was built with again, and puts it on the materials.
   *
   * A WebGL material is out of the stylesheet's reach: without this a viewer left open across a
   * change of theme went on drawing the fleet, the route and the cursor in the old one.
   */
  retint?: () => void
  /** The agent's own body, which nothing in the stream describes - see {@link showAgent}. */
  body?: Mesh
  /** Makes one, from the renderer's player model. Held so `showAgent` needs no imports. */
  buildBody?: () => Mesh | undefined
  /** three's texture constants, carried here so the nametag fix-up needs no import. */
  filters: { linear: number; clamp: number }
  /** Where the agent was last seen, so a jump can be told from a walk. See {@link frameCamera}. */
  lastAt?: { x: number; y: number; z: number }
  /** Where it was on the last followed frame, which is what a step is measured from. */
  followed?: { x: number; y: number; z: number }
  /** Where the body is actually drawn, which trails {@link position} rather than snapping to it. */
  shown?: { x: number; y: number; z: number; yaw: number }
  /** When the last frame was drawn, so the trailing does not depend on the frame rate. */
  drawnAt?: number
  /**
   * The world's vertical range, as the current stream stated it.
   *
   * Mutable and shared with {@link extendMeshedHeight}, so a new stream can correct it without
   * re-wrapping the renderer - wrapping twice would mark every section dirty twice over.
   */
  bounds: { minY: number; maxY: number }
  /** How many columns the host has sent, for {@link reportCoverage}. */
  received: number
  /** Entity ids seen on the wire, and the types they arrived as. */
  seen: Map<number, string>
  /** Usernames, for redrawing the nametags upstream draws off-centre. */
  names: Map<number, string>
  /** Where each entity is, for the distance on its label. */
  /** How big each is, for the box drawn around it. */
  sizes: Map<number, { width: number; height: number }>
  /**
   * The two halves of the path the agent is walking, when it is walking one.
   *
   * Two objects rather than one, because they are drawn differently: what is behind the agent is
   * faint and what is ahead is solid, which is what makes the direction of travel readable without
   * an arrowhead. Rebuilt whole on every change - a path arrives a few hundred nodes at a time and
   * only when it has been re-planned, so there is nothing to update in place.
   */
  pathLines?: Mesh[]
  /** Their widths are in pixels, so they are told the canvas size like the boxes are. */
  pathMaterials?: Array<{ resolution: { set(width: number, height: number): void } }>
  /** Builds one half. `spent` picks the faint material. */
  buildPath?: (points: number[], spent: boolean, anchor: { x: number; y: number; z: number }) => Mesh | undefined
  /** Marks each node of a path, so a route reads as the steps it is made of. */
  buildNodes?: (points: number[], spent: boolean, anchor: { x: number; y: number; z: number }) => Mesh | undefined
  /**
   * The box drawn around the block the cursor is over.
   *
   * One object, moved, rather than one per frame: a hover box is rebuilt sixty times a second by
   * definition, and building geometry at that rate is how a viewer starts dropping frames.
   */
  hover?: Mesh
  buildHover?: () => Mesh | undefined
  /**
   * A cage per build standing in this world, by {@link PlacedBox.id}, and what each was built for.
   *
   * Rebuilt rather than scaled when a box changes, unlike the hover cursor: a plan's cage is
   * dashed, and a dash is measured along the line — scaling a unit cage would stretch every dash
   * with it, into a line on the long edges and a dot on the short ones. Boxes move when somebody
   * edits a plan, which is rare enough to afford the geometry.
   */
  builds?: Map<string, { mesh: Mesh; key: string }>
  buildCage?: (box: PlacedBox['box'], kind: CageKind, type: JobType) => Mesh
  /** The cross on the point the camera turns around - see {@link showGimbal}. */
  gimbal?: Mesh
  buildGimbal?: () => Mesh | undefined
  /** The same cross, dashed, for wherever the world is in front of it. */
  ghost?: Mesh
  buildGhost?: () => Mesh | undefined
  /**
   * A box on every block the route still means to lay or break.
   *
   * The same outline as the one under the cursor, in green: what an operator is looking at is "what
   * is this agent about to do to the world", and the shape they already read as "this block" is the
   * right shape to say it with. Rebuilt whole, like the path, and for the same reason - the list
   * only changes when the route is redrawn or a block is finished.
   */
  workBoxes?: Mesh[]
  buildWork?: () => Mesh | undefined
  /** Where the pointer last was on the canvas, in normalised device coordinates. */
  over?: { nx: number; ny: number }
  /**
   * What block is under a point on the canvas, in normalised device coordinates.
   *
   * Held on the scene, like every other three-shaped thing here, so the component needs no imports
   * of its own - the renderer and its `THREE` are loaded once, inside the init closure.
   */
  pick?: (nx: number, ny: number) => { x: number; y: number; z: number } | undefined
  /** How far away the world is at a point on the screen, for {@link keepControlsUseful}. */
  depthAt?: (nx: number, ny: number) => number | undefined
  /** The wheel handler and what it is on, kept so teardown can take it off again. */
  wheeling?: { on: HTMLElement; handle: (event: WheelEvent) => void }
  /**
   * Zoom the wheel has asked for and the frames have not finished paying - see {@link glideZoom}.
   *
   * No `at` means the orbit target, which is where a zoom closes while following an agent.
   */
  zooming?: { left: number; flying: boolean }
  /** Builds an outline in the entity mesh's own units. Held so the decoration needs no imports. */
  buildOutline?: (width: number, height: number, tone: Tone) => Mesh | undefined
  buildNametag?: (height: number) => Mesh | undefined
  buildTexture?: (image: HTMLCanvasElement) => TextureLike
  buildSlim?: () => Mesh | undefined
  summary?: ReturnType<typeof setTimeout>
}

interface Mesh {
  /**
   * What the mesh is made of, for releasing it.
   *
   * Optional because half the things typed as one here are not meshes: a nametag is a sprite and an
   * entity's mount is a bare `Object3D`. A path is, which is why it is on the interface at all -
   * several hundred segments rebuilt on every re-plan is real memory to hand back.
   */
  geometry?: GeometryLike
  position: { set(x: number, y: number, z: number): void }
  scale: { set(x: number, y: number, z: number): void }
  rotation: { y: number }
  visible: boolean
  frustumCulled: boolean
  renderOrder: number
  userData: Record<string, unknown>
  add(child: unknown): void
  remove?(child: unknown): void
  children?: Array<{
    isSprite?: boolean
    isSkinnedMesh?: boolean
    /** Only a real mesh has one. The nametag sprite and the outline do not, and neither wears a skin. */
    geometry?: unknown
    frustumCulled: boolean
    renderOrder: number
    scale: { set(x: number, y: number, z: number): void }
    userData: Record<string, unknown>
    material?: SpriteMaterial
  }>
}

interface SpriteMaterial {
  /** Only on entity bodies, never on sprites. See `unskin`. */
  skinning?: boolean
  transparent: boolean
  depthWrite: boolean
  needsUpdate: boolean
  depthTest: boolean
  /** False keeps the label one size at every distance. */
  sizeAttenuation: boolean
  map?: TextureLike
}

/** As much of a `THREE.Texture` as this file touches. */
interface TextureLike {
  /** A canvas for anything built here; an `<img>` for the sheets the renderer loaded itself. */
  image?: HTMLCanvasElement | HTMLImageElement
  generateMipmaps: boolean
  minFilter: number
  magFilter: number
  wrapS: number
  wrapT: number
  needsUpdate: boolean
  /** Only the ones built here are ever disposed of - see {@link greyOne}. */
  dispose?(): void
}

/**
 * As much of a `THREE.BufferGeometry` as this file touches.
 *
 * The vertex streams themselves are no longer named here. They were, for the pass that shed them
 * after upload; a ray reads them now and it reads them through three own types, inside the closure
 * that has them.
 */
interface GeometryLike {
  dispose(): void
  computeBoundingSphere(): void
}

interface WorkerLike {
  terminate(): void
  onmessage: ((event: { data: { type: string; key?: string } }) => void) | null
}

interface WorldLike {
  /** Drops every column and mesh and tells the workers to forget the world. See {@link restream}. */
  resetWorld(): void
  texturesDataUrl?: string
  blockStatesData?: unknown
  scene: { remove(object: unknown): void }
  sectionMeshs?: Record<string, { geometry?: GeometryLike } | undefined>
  workers: WorkerLike[]
  loadedChunks?: Record<string, boolean>
  addColumn(x: number, z: number, chunk: unknown): void
  removeColumn(x: number, z: number): void
  setSectionDirty(pos: { x: number; y: number; z: number }, value?: boolean): void
}

interface ViewerLike {
  camera: {
    /** Read as well as written: following moves it by the same step the agent took. */
    position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
    aspect: number
    updateProjectionMatrix(): void
  }
  scene: { add(object: unknown): void; remove(object: unknown): void }
  world: WorldLike
  entities?: { entities?: Record<string, Mesh | undefined> }
  setVersion(version: string): boolean
  listen(emitter: Emitter): void
  setFirstPersonCamera(pos: unknown, yaw: number, pitch: number): void
  update(): void
}

onMounted(() => void connect())
onBeforeUnmount(teardown)

let stopTheme: (() => void) | undefined
onMounted(() => (stopTheme = onThemeChange(() => scene.value?.retint?.())))
onBeforeUnmount(() => stopTheme?.())

// Cleared rather than kept: the step measured from a position several minutes old would throw the
// camera across the world on the frame following it being switched back on.
watch(follow, (on) => {
  const current = scene.value
  if (current) delete current.followed
  if (!on) return
})

watch(firstPerson, (on) => {
  const current = scene.value
  if (!current) return

  // Orbit has to be switched off, not merely left un-updated: it goes on listening for drags and
  // moving the camera, which then fights the agent's own head for it every frame.
  if (current.controls) current.controls.enabled = !on

  // And the agent's body has to go. The camera sits inside it in first person, so what it renders
  // is the inside of its own skull.
  if (current.body) current.body.visible = !on

  if (on) return
  // Coming back out, the orbit camera is wherever that head left it. Pulled back to where the free
  // camera started.
  const at = current.position?.pos
  if (!at) return
  current.controls?.target.set(at.x, at.y, at.z)
  current.viewer.camera.position.set(at.x, at.y + 20, at.z + 20)
})

/**
 * The stream this screen is on, whether or not there is a scene drawing from it yet.
 *
 * Kept beside the scene rather than inside it: the two are created at different moments, and the
 * gap between them is where a version has to be staged.
 */
let live: WebSocket | undefined

async function connect(): Promise<void> {
  status.value = 'connecting'

  const { data, error } = await api.POST('/api/agents/{id}/viewer/ticket', {
    params: { path: { id: props.agentId } },
  })
  if (error || !data?.ticket || !data.protocol) return fail(t('viewer.refused'))

  // The ticket travels as a subprotocol rather than in the URL: a URL is written to access logs and
  // browser history, and this one stands in for an authorization check.
  const socket = new WebSocket(socketUrl(), [data.protocol, data.ticket])
  socket.binaryType = 'arraybuffer'
  live = socket

  /*
   * **One frame at a time, in the order they were sent.**
   *
   * Decoding is asynchronous, and a gzipped column takes far longer than a bare position or an
   * unload. Handed to `receive` as they arrived, frames were applied in whatever order they finished
   * decoding: an unload landed before the load it undid, leaving a column in the scene - and in every
   * meshing worker - that nothing would ever remove again, which is a viewer that grows for as long as
   * the agent walks. And across a respawn a frame from the life before could land after the new
   * stream had started, putting the old world back and aiming the camera at the place the agent died.
   *
   * A frame that throws is logged and the queue goes on: one bad frame must not stop every later one.
   */
  let arriving = Promise.resolve()
  socket.onmessage = (message) => {
    const buffer = message.data as ArrayBuffer
    arriving = arriving
      .then(() => receive(buffer, socket))
      .catch((err: unknown) => console.error('[osmium] viewer frame failed', err))
  }

  // A socket that never opened and one that dropped are different failures, and saying so matters:
  // the first is a handshake that was refused or never proxied, the second is an agent that went
  // away. Reported from `close` in both cases - `error` on a WebSocket carries no detail by design,
  // and fires before the close that does distinguish them.
  socket.onclose = (event) => {
    if (status.value === 'failed') return
    // The close code is the only account anyone gets of why a stream ended, and it is not otherwise
    // recoverable from the page - 1006 is a transport that failed, 1009 a frame too large for the
    // receiver, 1011 the server giving up. Worth a line whenever it was not a clean goodbye.
    if (!event.wasClean) {
      console.error(`[osmium] viewer socket closed: code=${event.code} reason=${event.reason || '(none)'}`)
    }
    fail(status.value === 'watching' || event.wasClean ? t('viewer.lost') : t('viewer.unreachable'))
  }
}

/**
 * Says what arrived versus what was drawn, once the world stops changing.
 *
 * The three stages - a column sent by the host, accepted by the renderer, and meshed into geometry -
 * fail independently and look identical from the outside, which is a hole in the world either way.
 * One line naming all three turns "some chunks are missing" into which stage lost them.
 */
function reportCoverage(current: Scene): void {
  // Development only. It answers exactly one question - which stage lost a column - and that
  // question is asked while working on the viewer, not by an operator watching an agent.
  if (!import.meta.env.DEV) return

  clearTimeout(current.summary)
  current.summary = setTimeout(() => {
    const columns = Object.keys(current.viewer.world.loadedChunks ?? {})
    const meshed = new Set(
      Object.keys(current.viewer.world.sectionMeshs ?? {}).map((key) => {
        const [x, , z] = key.split(',')
        return `${x},${z}`
      }),
    )
    // Distance from the agent is what separates the two reasons a column can be blank. One that is
    // empty - a void column, most of the End - is correctly not drawn and will be out at the edge.
    // One that was lost is wherever it happened to be, and a hole beside the agent is the report
    // that matters. Sorted nearest first so the difference is legible rather than inferred.
    const at = current.position?.pos
    const home = { x: Math.floor((at?.x ?? 0) / 16) * 16, z: Math.floor((at?.z ?? 0) / 16) * 16 }
    const away = (column: string) => {
      const [x, z] = column.split(',').map(Number)
      return Math.max(Math.abs((x ?? 0) - home.x), Math.abs((z ?? 0) - home.z)) / 16
    }

    const undrawn = columns.filter((column) => !meshed.has(column)).sort((a, b) => away(a) - away(b))
    const near = undrawn.filter((column) => away(column) <= 2)

    // Which vertical band the geometry actually landed in. Upstream meshes y 0..255 on its own and
    // `extendMeshedHeight` is what covers the rest, so a world that is whole in the middle and gone
    // at both ends says that wrapper stopped being reached - a different fault from a column that
    // never arrived, and indistinguishable from one without counting the sections.
    let below = 0
    let band = 0
    let above = 0
    for (const key of Object.keys(current.viewer.world.sectionMeshs ?? {})) {
      const y = Number(key.split(',')[1])
      if (Number.isNaN(y)) continue
      if (y < UPSTREAM_MIN_Y) below++
      else if (y >= UPSTREAM_MAX_Y) above++
      else band++
    }

    // `info`, not `debug`: the browser hides debug behind a verbosity setting that is off by
    // default, so a line nobody sees is a line that does not exist.
    const drawn = Object.keys(current.viewer.entities?.entities ?? {}).length
    const kinds = [...new Set(current.seen.values())].sort().join(' ')

    console.info(
      `[osmium] viewer entities: ${current.seen.size} seen, ${current.undrawable.size} skipped, ` +
        `${drawn} drawn — types: ${kinds || '(none)'}`,
    )
    console.info(
      `[osmium] viewer @ ${home.x},${home.z}: host sent ${current.received} columns, ` +
        `renderer holds ${columns.length}, ${columns.length - undrawn.length} have geometry. ` +
        `${undrawn.length} blank, ${near.length} of them within 2 columns of the agent. ` +
        `Sections: ${below} below y0, ${band} in 0..255, ${above} above y255. ` +
        `Extension: ${extended.levels} levels outside the band, ` +
        `${extended.marks} marks over ${extended.columns} columns` +
        (undrawn.length ? ` — nearest blank: ${undrawn.slice(0, 8).map((c) => `${c}(${away(c)})`).join(' ')}` : ''),
    )
  }, SETTLED)
}

/** How long without a column before the world is considered done arriving. */
const SETTLED = 2_000

/**
 * The slim player, which `scripts/viewer-assets.mjs` adds to the renderer's entity table.
 *
 * Named here and derived there. It cannot be registered from this side: `Entity.js` does
 * `require('./entities.json')` and the bundler inlines that table into its pre-bundle of the
 * package, so an import of the same path from application code is a different object. Adding a
 * model to it added nothing to what `Entity` could build, and asking for one threw.
 */
const SLIM = 'osmium_player_slim'

/** The vertical range the renderer meshes on its own, hardcoded in its `addColumn`. */
const UPSTREAM_MIN_Y = 0
const UPSTREAM_MAX_Y = 256
const SECTION = 16

/**
 * Extends meshing to the rest of the world's height.
 *
 * `WorldRenderer.addColumn` marks sections dirty with `for (let y = 0; y < 256; y += 16)`, which was
 * the whole world before 1.18 and is now a slice out of its middle. Everything below y=0 and above
 * y=255 is loaded, sent to the workers and then never asked for - so it is simply absent, in
 * horizontal bands, which is what makes it look like chunks half-loading rather than a fixed range.
 * `removeColumn` has the same bound, so those sections would also never be cleaned up.
 *
 * Wrapped rather than forked: upstream still does its own range, and this does what is left over.
 * The neighbour marking mirrors upstream's, because a section's mesh depends on the blocks facing it
 * across each border.
 */
/** What the wrapper below has actually done, for {@link reportCoverage}. Development only. */
const extended = { levels: 0, marks: 0, columns: 0 }

function extendMeshedHeight(world: WorldLike, bounds: { minY: number; maxY: number }): void {
  const outside = (): number[] => {
    const levels: number[] = []
    const from = Math.floor(bounds.minY / SECTION) * SECTION
    for (let y = from; y < bounds.maxY; y += SECTION) {
      if (y < UPSTREAM_MIN_Y || y >= UPSTREAM_MAX_Y) levels.push(y)
    }
    return levels
  }

  const added = world.addColumn.bind(world)
  world.addColumn = (x: number, z: number, chunk: unknown) => {
    added(x, z, chunk)

    // Read per column rather than once, because the bounds are the stream's and a new stream may
    // state different ones - a different dimension has a different floor and ceiling.
    const levels = outside()
    extended.levels = levels.length
    extended.columns++

    for (const y of levels) {
      for (const [dx, dz] of NEIGHBOURS) {
        world.setSectionDirty({ x: x + dx, y, z: z + dz })
        extended.marks++
      }
    }
  }

  const removed = world.removeColumn.bind(world)
  world.removeColumn = (x: number, z: number) => {
    removed(x, z)
    const meshes = world.sectionMeshs
    for (const y of outside()) {
      world.setSectionDirty({ x, y, z }, false)
      const key = `${x},${y},${z}`
      const mesh = meshes?.[key]
      if (!mesh || !meshes) continue
      world.scene.remove(mesh)
      // The material is shared across every section, so only the geometry is this mesh's to free.
      mesh.geometry?.dispose()
      delete meshes[key]
    }
  }
}

/** The column itself and the four it shares a face with. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-SECTION, 0],
  [SECTION, 0],
  [0, -SECTION],
  [0, SECTION],
]

/**
 * How many meshing workers to run. Upstream hardcodes four in `WorldRenderer`'s constructor.
 *
 * Meshing is sharded across them, but the world is not: `addColumn` hands every column to every
 * worker, and each one parses its own copy of the block states - 12.7 MB of JSON that costs about
 * 30 MB of heap once parsed. A worker is therefore a large fixed cost for a share of the meshing,
 * and the fourth was buying less than it cost.
 */
const WORKERS = 3

/**
 * Settles a finished section mesh: gives it the bounds the renderer needs on its first frame.
 *
 * **This used to shed the vertex data as well**, and no longer can. `BufferAttribute` keeps the
 * `Float32Array` it was built from alive for as long as the mesh is in the scene, so every section
 * is held twice over - once in the GPU buffer that draws it and once on the JS heap - and an
 * `onUpload` callback that nulled the second was worth real memory: the renderer does no greedy
 * meshing, so a section is four vertices of eleven floats per visible face, 24 sections a column
 * across 144 columns.
 *
 * What changed is that something now reads the vertices back. Clicking the world casts a ray at
 * these very meshes - see `Scene.pick` - and a ray needs the positions and the index to say which
 * face it hit. Shedding them left every click answering with nothing, which is exactly what the
 * comment here used to promise could not happen: it said raycasting was the one thing that would
 * want this copy, and that nothing here raycast.
 *
 * The bounds are still computed here, while the data exists, because frustum culling needs them
 * before the first frame is drawn.
 */
function settleGeometry(mesh: { geometry?: GeometryLike } | undefined): void {
  mesh?.geometry?.computeBoundingSphere()
}

/**
 * Hands a geometry back for good, for something being taken out of the scene.
 *
 * Not the same act as {@link settleGeometry}: that one is about a mesh which stays and is being
 * tidied, this one is about a mesh which is going. `dispose` is what frees the GPU buffer, and
 * nothing else here does.
 */
function disposeGeometry(mesh: { geometry?: GeometryLike } | undefined): void {
  mesh?.geometry?.dispose()
}

/**
 * Textures built here for one body: skins and drained copies, freed with the body they were made for.
 *
 * A set rather than a mark on the texture, because the renderer's three predates `Texture.userData` -
 * writing one threw inside `buildTexture`, and every skin after it silently failed to go on.
 */
const ownedTextures = new WeakSet<object>()

/** The parts of a three object that {@link release} frees, without the rest of its type. */
interface Releasable {
  children?: unknown[]
  geometry?: { dispose(): void }
  skeleton?: { dispose(): void }
  isSprite?: boolean
  userData?: Record<string, unknown>
  material?: { map?: unknown; dispose?(): void } | null
}

/**
 * Frees everything one body holds, all the way down.
 *
 * **Upstream frees the wrong object.** Its `dispose3` is handed an entity's root, which is a bare
 * `Object3D` with no geometry of its own: the body, its skeleton, its nametag and the box drawn here
 * all hang below it. So every mob that walked out of view left its geometry, its materials and its
 * label behind for the life of the page, and a viewer left open on a busy spot grew by gigabytes.
 *
 * **What is shared is left alone.** The box's material is one per colour for the whole scene, and a
 * texture from upstream's cache is worn by every entity naming that file. What goes is what was built
 * for this body: its geometry, skeleton and materials, its nametag's texture - one canvas per label,
 * upstream's and ours alike - and any skin or drained copy built here, which {@link ownedTextures} holds.
 */
function release(object: unknown): void {
  const node = object as Releasable | undefined
  if (!node) return

  for (const child of node.children ?? []) release(child)

  node.geometry?.dispose()
  node.skeleton?.dispose()

  // One material per colour, for every box in the scene.
  if (node.userData?.['osmiumOutline']) return

  const ownTexture = (texture: unknown) => {
    if (texture && typeof texture === 'object' && ownedTextures.has(texture)) {
      ;(texture as { dispose?(): void }).dispose?.()
    }
  }
  ownTexture(node.userData?.['osmiumGreyed'])
  ownTexture(node.userData?.['osmiumLively'])

  const material = node.material
  if (!material) return
  if (node.isSprite) (material.map as { dispose?(): void } | undefined)?.dispose?.()
  else ownTexture(material.map)
  material.dispose?.()
}

/**
 * The entity types the renderer can actually build, which is fewer than the ones it lists.
 *
 * Six of its models name a parent bone they never define - a piglin's `leftItem` hangs off a
 * `leftArm` that is not in the model, and a witch's nose off an absent `head`. Building one throws
 * on `bones[parent].add(...)`, which upstream catches and answers with a magenta box sized from
 * fields a movement update does not carry, so it arrives as `NaN` geometry.
 *
 * Checked rather than listed: the six are upstream's data, and a list written here would go stale
 * the moment that data changed in either direction.
 */
function buildableModels(entities: Record<string, { geometry?: Record<string, { bones?: Array<{ name: string; parent?: string }> }> }>): Set<string> {
  const usable = new Set<string>()

  for (const [name, entity] of Object.entries(entities)) {
    const models = Object.values(entity.geometry ?? {})
    const whole = models.every((model) => {
      const bones = model?.bones ?? []
      const defined = new Set(bones.map((bone) => bone.name))
      return bones.every((bone) => !bone.parent || defined.has(bone.parent))
    })
    if (whole) usable.add(name)
  }

  return usable
}

/**
 * Whether the renderer has a model for this entity, decided before it is asked.
 *
 * It carries geometry for the mobs it knows and, for anything else, logs `Unknown entity <type>`
 * and substitutes a magenta box - so a server with dropped items, item frames and end crystals
 * fills the console and scatters pink cubes through the world. Neither is useful, and a thing shown
 * as the wrong shape is worse than a thing not shown. The same goes for the types whose model is
 * present but cannot be assembled.
 *
 * Only a spawn names its type; every movement after it is an id and a position. So an entity ruled
 * out here is remembered, and its later updates are dropped with it.
 */
function drawable(current: Scene, entity: { id: number; name?: string; delete?: true }): boolean {
  // A removal always passes, and clears the ruling with it. It carries no name, so it used to fall
  // through to the nameless branch below and blacklist the id - and ids are reused: a player who
  // walks out of view distance and back arrives under the same one, now permanently unable to be
  // drawn. It also says nothing about whether the thing was drawable; it says it is gone.
  if (entity.delete) {
    current.undrawable.delete(entity.id)
    return true
  }

  // A name is the authority and may arrive after a nameless update was ruled out, so it clears a
  // previous ruling rather than being refused by it.
  if (entity.name !== undefined) {
    if (current.models.has(entity.name)) {
      current.undrawable.delete(entity.id)
      return true
    }
    current.undrawable.add(entity.id)
    return false
  }

  if (current.undrawable.has(entity.id)) return false

  // Nameless, and the renderer has never seen this id. Only the first update for an entity carries
  // its type, and `getEntityMesh` builds a model only when it has one - given none, it falls
  // through to a box sized from `entity.width` and `entity.height`, which a movement update does
  // not carry either. The result is `NaN` geometry that three then complains about on every frame.
  // mineflayer leaves `name` undefined for entity types it does not recognise, so this is how a
  // server running something newer than the library reaches the renderer.
  if (!current.viewer.entities?.entities?.[entity.id]) {
    current.undrawable.add(entity.id)
    return false
  }

  return true
}

/**
 * Takes entity bodies off the skinning path, which they only ever used to arrive back where they
 * started - and which tears them apart once the world coordinates get large.
 *
 * Upstream builds every entity as a `SkinnedMesh` and bakes each bone's transform into the vertices
 * as it emits them, then never moves a bone again: the only thing animated is `rotation.y` on the
 * parent. So every bone matrix stays equal to the mesh's own `matrixWorld`, the bind matrix is the
 * identity, and the skinning the shader performs reduces to `inverse(matrixWorld) * matrixWorld * v`.
 *
 * That identity is not free, because the shader evaluates it in float32 while the CPU would have
 * folded the world out in float64. `bindMatrixInverse` carries the entity's position scaled by 16
 * (the mesh is a sixteenth scale), so at x = 13,554,753 the vertex passes through -2.2e8, where
 * consecutive float32 values are 16 model units apart - one whole block. Every x within a body
 * rounds to the same number and the model collapses to a sheet, which shifts to the next cell as
 * the entity walks: flat, and flickering. The other axes survive or not depending on their own
 * magnitude, which is why it looks like corruption rather than an obvious failure.
 *
 * Switching skinning off leaves `projectionMatrix * modelViewMatrix * position`, and three builds
 * that model-view on the CPU relative to the camera, so nothing large reaches the GPU at all.
 */
function unskin(mesh: Mesh | undefined): void {
  for (const child of mesh?.children ?? []) {
    if (!child.isSkinnedMesh) continue
    const material = child.material
    if (!material || material.skinning === false) continue
    material.skinning = false
    // The define is compiled into the program, so the material has to be told to rebuild it.
    material.needsUpdate = true
  }
}

/**
 * Dresses a player in their own skin.
 *
 * The renderer builds every player from `steve.png` — one texture named in its entity table, with
 * no notion that two players look different. What it does give us is a material per mesh, so the
 * texture on one player can be replaced without touching the others or the renderer.
 *
 * **Each player gets a texture of its own, and that is not an optimisation to skip.** Upstream
 * caches textures by URL — `loadTexture` keeps a `textureCache` and hands the same `THREE.Texture`
 * to every caller — so the one on a player belongs to every player *and* to the agent's own body.
 * Writing an image into it dressed the whole world in whichever skin arrived last.
 *
 * Built rather than cloned. A clone carries whatever else that shared object has been left in, and
 * the four settings a skin actually needs are worth stating; see `buildTexture`.
 *
 * Once per entity, marked on the mesh. The fetch is memoised per player besides, so a fleet of one
 * account standing together is one request either way; this is about not re-walking the children of
 * every player on every frame.
 *
 * Silent when there is no skin. A player whose name the service does not know, or a deployment with
 * skins turned off, simply stays Steve — which is what the screen showed before this existed.
 */
function wear(current: Scene, id: number, mesh: Mesh): void {
  if (mesh.userData['osmiumSkinned']) return

  const name = current.names.get(id)
  if (!name) return

  skin(current, mesh, name)
}

/**
 * Fetches one account's skin and puts it on one model.
 *
 * Shared by the two paths that need it: every player in view, and the agent's own body, which is
 * built here rather than streamed.
 */
function skin(current: Scene, mesh: Mesh, name: string): void {
  if (mesh.userData['osmiumSkinned']) return

  // Marked before the fetch, not after: the answer takes a round trip and the caller runs per frame.
  mesh.userData['osmiumSkinned'] = true

  void skinFor(name).then((worn) => worn && dress(current, mesh, worn))
}

/**
 * Puts one skin on one model, narrowing the model first if the skin was drawn for a slim one.
 *
 * **The body is replaced rather than re-textured** for a slim skin, because the difference is a
 * pixel of geometry rather than of texture: the renderer builds every player four-pixel-armed, and
 * a three-pixel sheet worn on that model runs a column of the sleeve's neighbour down each arm.
 *
 * Only the parts with geometry are swapped. The nametag and the outline hang off the same object
 * and belong to it, not to the body — and rebuilding either would lose what has already been done
 * to them.
 *
 * Safe to swap at all because upstream animates nothing below the mesh: it tweens the whole thing's
 * position and yaw, and never touches a bone.
 */
function dress(current: Scene, mesh: Mesh, worn: Skin): void {
  const replacement = worn.slim ? current.buildSlim?.() : undefined

  if (replacement) {
    for (const child of [...(mesh.children ?? [])]) {
      if (child.isSprite || child.userData['osmiumOutline'] || !child.geometry) continue
      mesh.remove?.(child)
      // The wide body being replaced, which nothing else will ever free.
      release(child)
    }
    for (const child of [...(replacement.children ?? [])]) mesh.add(child)
    // A body that arrives this way has not been through the pass that walks the renderer's list.
    unskin(mesh)
  }

  for (const child of mesh.children ?? []) {
    // The nametag is a sprite and the outline is a line list; what is left is the body.
    if (child.isSprite || child.userData['osmiumOutline'] || !child.geometry) continue

    const material = child.material
    if (!material?.map) continue

    const own = current.buildTexture?.(worn.image)
    if (!own) continue

    material.map = own
    material.needsUpdate = true
  }

  // A skin can land after its owner has already been dropped from the stream, and the pass that
  // drains a ghost only runs on entity events - of which a world whose last player just left sends
  // none. So the drain is applied here too, over whatever was just put on.
  if (mesh.userData['osmiumGone']) greyOne(current, mesh, true)
}

/** Whether a name belongs to the fleet, which is what decides the colour of the box around it. */
function ourPlayer(name: string | undefined): boolean {
  if (!name) return false
  if (agent.value?.mcUsername === name) return true
  return nearby.value.some((candidate) => candidate.name === name && candidate.isAgent)
}

/**
 * A box around one player, in the colour the map uses for the same person.
 *
 * Rebuilt rather than recoloured when the answer changes. Whether somebody is ours arrives with the
 * telemetry, which can land after the entity does, so the first box is sometimes drawn for a
 * stranger who turns out to be an agent - and a box built once and left is one that stays the wrong
 * colour for the rest of the session. It happens about once per player. A body that goes on being
 * drawn after the stream has dropped it changes tone the same way, in the other direction.
 */
function outlineOne(
  current: Scene,
  mesh: Mesh,
  tone: Tone,
  size: { width: number; height: number } | undefined,
): void {
  if (mesh.userData['osmiumOutlined'] && mesh.userData['osmiumTone'] === tone) return

  if (mesh.userData['osmiumOutlined']) {
    for (const child of [...(mesh.children ?? [])]) {
      if (!child.userData['osmiumOutline']) continue
      mesh.remove?.(child)
      release(child)
    }
  }

  const outline = size && current.buildOutline?.(size.width, size.height, tone)
  if (!outline) return

  mesh.userData['osmiumOutlined'] = true
  mesh.userData['osmiumTone'] = tone
  mesh.add(outline)
}

/**
 * Drains the colour out of a body, or puts it back.
 *
 * The same idea as the grey marker on the map, and for the same reason: what is on screen is a real
 * position that was true when it was taken, and the one thing it must not look like is a live one.
 *
 * **A copy of the texture, never the texture itself.** The renderer caches sheets by URL and hands
 * the same `THREE.Texture` to every entity that names one, so a player with no skin of their own is
 * wearing the very object every other Steve in the world is wearing. Draining that in place would
 * grey the living along with the dead. The material, unlike the texture, belongs to this mesh.
 *
 * Keyed off the texture rather than off a flag, so a skin that lands after the drain is drained in
 * turn rather than being taken for one that already has been.
 */
function greyOne(current: Scene, mesh: Mesh, gone: boolean): void {
  mesh.userData['osmiumGone'] = gone

  for (const child of mesh.children ?? []) {
    // The nametag is a sprite and the outline is a line list; what is left is the body.
    if (child.isSprite || child.userData['osmiumOutline'] || !child.geometry) continue

    const material = child.material
    if (!material?.map) continue

    if (gone) {
      if (child.userData['osmiumGreyed'] === material.map) continue

      const drained = fade(material.map.image)
      const texture = drained && current.buildTexture?.(drained)
      if (!texture) continue

      child.userData['osmiumLively'] = material.map
      child.userData['osmiumGreyed'] = texture
      material.map = texture
      material.needsUpdate = true
      continue
    }

    const lively = child.userData['osmiumLively'] as TextureLike | undefined
    if (!lively) continue

    material.map = lively
    // Built here, so it is this file's to free. The one it replaced is upstream's or the skin's.
    ;(child.userData['osmiumGreyed'] as TextureLike | undefined)?.dispose?.()
    child.userData['osmiumLively'] = undefined
    child.userData['osmiumGreyed'] = undefined
    material.needsUpdate = true
  }
}

/** A drained copy of whatever a texture was drawn from, at its own size. */
function fade(image: HTMLCanvasElement | HTMLImageElement | undefined): HTMLCanvasElement | null {
  if (!image) return null

  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height
  if (!width || !height) return null

  const drained = document.createElement('canvas')
  drained.width = width
  drained.height = height

  const ctx = drained.getContext('2d')
  if (!ctx) return null

  // Nearest neighbour, as everywhere else a skin is touched: this is a 64-pixel sheet.
  ctx.imageSmoothingEnabled = false
  ctx.filter = 'grayscale(1)'
  ctx.drawImage(image, 0, 0)
  return drained
}

/**
 * Corrects a nametag and keeps what it says current.
 *
 * Upstream creates the sprite for a streamed player; the agent's own body has one built for it here
 * - see `buildNametag` - and both arrive needing the same three corrections, so both come through
 * this.
 *
 * Three things are wrong with it as built. It is drawn onto a 500x100 canvas and mapped onto a
 * `THREE.Sprite`, which is a one-by-one quad unless told otherwise, so the name arrives squashed to
 * a fifth of its width. That canvas is not a power of two, and the texture is left on the default
 * mipmapping and repeat wrapping, so everything past the text samples outside the image and comes
 * back as streaked noise. And the material is not marked transparent, so the empty area around the
 * name is composited rather than dropped.
 */
function labelOne(current: Scene, mesh: Mesh, name: string | undefined, tone: Tone, since?: number): void {
  for (const child of mesh.children ?? []) {
    if (!child.isSprite || child.userData['osmiumOutline']) continue
    child.frustumCulled = false

    if (!child.userData['osmiumShaped']) {
      child.userData['osmiumShaped'] = true

      // Last in the transparent pass, whatever the camera thinks the order should be.
      //
      // The entity's own material is transparent too, so both it and this sprite are sorted
      // back-to-front by distance - and orbiting the player swaps which of the two is nearer. For
      // the half-circle where the body sorts last it is drawn over the tag, which is why the name
      // vanished for half of every turn. Turning depth testing off does not help: nothing is being
      // tested, the body simply arrives later.
      child.renderOrder = NAMETAG_ORDER
      child.scale.set(NAMETAG_WIDTH, NAMETAG_WIDTH * (NAMETAG_CANVAS.height / NAMETAG_CANVAS.width), 1)

      const material = child.material
      if (material) {
        // Upstream draws its tags onto a 500x100 canvas, which is the room for two lines of text
        // and nothing else. The face goes above them, so the sheet is grown to match the shape the
        // scale above assumes. Resizing clears it, which costs nothing: it is redrawn below.
        const upstream = material.map?.image
        if (upstream instanceof HTMLCanvasElement && upstream.height !== NAMETAG_CANVAS.height) {
          upstream.width = NAMETAG_CANVAS.width
          upstream.height = NAMETAG_CANVAS.height
        }

        material.transparent = true
        material.depthWrite = false
        // One size, whatever the distance. A sprite shrinks with range by default, which is right
        // for a thing in the world and wrong for a label about one: the name furthest away is the
        // hardest to read and often the one worth reading.
        material.sizeAttenuation = false
        // Over the world, as Minecraft draws them: depth-tested, a tag is occluded by the very head
        // it labels at every angle where that head is nearer the camera.
        material.depthTest = false

        const sheet = material.map
        if (sheet) {
          // Clamped and unmipped: what a non-power-of-two texture needs, and what stops the sampler
          // reaching past the edge of the drawn name.
          sheet.generateMipmaps = false
          sheet.minFilter = current.filters.linear
          sheet.magFilter = current.filters.linear
          sheet.wrapS = current.filters.clamp
          sheet.wrapT = current.filters.clamp
        }
        material.needsUpdate = true
      }
    }

    // Outside the once-only block: the distance and the vitals change as everybody moves, so the
    // label is redrawn when the text it shows would differ - not every frame, and not never.
    const map = child.material?.map
    const sheet = map?.image
    // Upstream's tag and the one built here are both canvases; nothing else reaches this.
    if (!map || !(sheet instanceof HTMLCanvasElement)) continue

    const mark = markFor(name)
    // A body the stream has dropped says when it was last seen instead of how it was doing: the
    // vitals belong to somebody the fleet can still see, and this one it cannot.
    const detail =
      since === undefined ? (mark?.detail ?? null) : t('viewer.lastKnown', { when: atTime(since) })
    const head = headFor(current, name)

    // The face counts as part of what is drawn, so its arrival has to count as a change: it is
    // fetched, and it lands long after the first label was painted. So does the tone's colour, which
    // is what the face is outlined in - and which a change of theme changes under the same tone.
    const text = `${mark?.label ?? ''}|${detail ?? ''}|${head ? 'face' : ''}|${current.tones[tone]}`
    if (child.userData['osmiumLabel'] === text) continue
    child.userData['osmiumLabel'] = text

    redrawNametag(sheet, {
      label: mark?.label,
      detail,
      head,
      outline: current.tones[tone],
      faded: since !== undefined,
    })
    map.needsUpdate = true
  }
}

/** Decorates everything the renderer is holding: skins, boxes and labels, once each per entity. */
function shapeNametags(current: Scene): void {
  for (const [key, mesh] of Object.entries(current.viewer.entities?.entities ?? {})) {
    if (!mesh) continue
    const id = Number(key)
    unskin(mesh)

    // These meshes are built with their geometry in absolute model coordinates while their bones
    // carry accumulated pivots, so the bounding sphere three computes for them does not describe
    // where they actually are - and an entity disappears at the angles where that wrong sphere
    // leaves the frustum. There are a few dozen of them; not culling them costs nothing.
    mesh.frustumCulled = false

    // Skinned and boxed, but only players: an operator watching an agent is watching for people,
    // and outlining every cow would bury them. The box takes the map's colour for the same person,
    // so the two screens never disagree about who is ours.
    const name = current.names.get(id)
    const since = current.ghosts.get(id)
    const tone: Tone = since !== undefined ? 'gone' : ourPlayer(name) ? 'ours' : 'theirs'

    if (current.seen.get(id) === 'player') {
      wear(current, id, mesh)
      greyOne(current, mesh, since !== undefined)
      outlineOne(current, mesh, tone, current.sizes.get(id))
    }

    labelOne(current, mesh, name, tone, since)
  }
}

/**
 * Draws the name again, centred and legible.
 *
 * Upstream writes it left-aligned from a fifth of the way across a 500-pixel canvas, so where the
 * name sits over its player depends on how long the name is - and paints it black on nothing, which
 * disappears against half the blocks in the game. Redrawn here because the position is baked into
 * the texture: no amount of moving the sprite can centre text that is off-centre within it.
 */
/**
 * The second line: how far, how well connected, and how they are playing.
 *
 * Read from the agent's own telemetry rather than the world stream. The fleet already reports who
 * is nearby and what the server said about them, so this needs nothing new on the wire - and the
 * two sources agree, because both are the same server's account of the same people.
 */
function markFor(name: string | undefined): { label: string; detail: string | null } | null {
  if (!name) return null

  // One of ours: the agent's Osmium label above, and under it exactly the line the map writes -
  // its Minecraft name and its vitals, read from the fleet's own telemetry rather than from what
  // the agent could see of it. Food is not something one player learns about another.
  const fleet = agentStore.agents.find((candidate) => candidate.mcUsername === name)
  if (fleet) return { label: fleet.label, detail: agentDetail(fleet) || null }

  // Anybody else is named by the only name there is for them, over the same reading the map gives
  // a stranger. A player the telemetry has not described yet gets the name alone.
  const player = nearby.value.find((candidate) => candidate.name === name)
  return { label: name, detail: (player && playerVitals(player)) || null }
}

/**
 * The face out of a skin sheet: the front of the head, with the hat layer laid over it.
 *
 * The same eight pixels the map draws beside a marker, cut here rather than fetched: the skin is
 * already in hand for the body, and the head endpoint would be a second request for a crop of it.
 */
function headshot(worn: HTMLCanvasElement): HTMLCanvasElement | null {
  const face = document.createElement('canvas')
  face.width = FACE
  face.height = FACE

  const ctx = face.getContext('2d')
  if (!ctx) return null

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(worn, 8, 8, FACE, FACE, 0, 0, FACE, FACE)
  // The second layer, which is a hat on most skins and the whole face on a few.
  ctx.drawImage(worn, 40, 8, FACE, FACE, 0, 0, FACE, FACE)
  return face
}

/**
 * The face for one account, once it is there.
 *
 * Claimed with a null before the request, so the label pass - which runs every frame for the
 * agent's own body - asks once rather than on every frame the skin is in flight. Null is also the
 * settled answer for somebody who has no skin, and their label is simply drawn without a face.
 */
function headFor(current: Scene, name: string | undefined): HTMLCanvasElement | null {
  if (!name) return null

  const held = current.heads.get(name)
  if (held !== undefined) return held

  current.heads.set(name, null)
  void skinFor(name).then((worn) => {
    if (worn) current.heads.set(name, headshot(worn.image))
  })
  return null
}

/** The face on a skin sheet, in its own pixels. */
const FACE = 8

/**
 * How big the face is drawn on a label, how far it sits from the top of it, and how much room is
 * left between it and the first line of text.
 *
 * `HEADSHOT_TOP` is not zero because the face is outlined, and a stroke centred on the edge of the
 * canvas loses its outer half.
 */
const HEADSHOT = 56
const HEADSHOT_TOP = 6
const HEADSHOT_GAP = 8

/** How heavy that outline is. The weight the text is haloed at, which is what it is drawn beside. */
const HEADSHOT_OUTLINE = 6

/** The protocol's own numbering. Survival is the default and says nothing, so it is left unnamed. */
function redrawNametag(
  canvas: HTMLCanvasElement,
  mark: {
    label: string | undefined
    detail: string | null
    head: HTMLCanvasElement | null
    /** What the face is ringed in: the colour of the box around the body it belongs to. */
    outline: string
    /** Drawn drained, for a body the stream has dropped. See {@link greyOne}. */
    faded: boolean
  },
): void {
  const { label, detail, head, outline, faded } = mark
  if (!label) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.filter = 'none'

  // Whatever the face does not take, measured from under it. Without one that is the whole label,
  // which is what a mob's tag and a player whose skin never arrived both get.
  const under = head ? HEADSHOT_TOP + HEADSHOT + HEADSHOT_GAP : 0
  const band = canvas.height - under

  // The same two lines the map draws, in the same order: who, then how they are doing.
  const lines = detail
    ? [
        { text: label, y: under + band * 0.34, size: band * 0.48, colour: '#ffffff' },
        { text: detail, y: under + band * 0.78, size: band * 0.3, colour: '#d4d4d8' },
      ]
    : [{ text: label, y: under + band / 2, size: band * 0.62, colour: '#ffffff' }]

  const room = canvas.width - NAMETAG_MARGIN * 2

  // **Shrunk to fit, never clipped.** The canvas is a fixed 500 wide and the sprite a fixed width
  // in the world, so a long line - an agent's label, its Minecraft name and its vitals - ran off
  // both ends and lost its first and last words to the edges. Measured once and scaled: a string
  // is linear in its font size, so one pass lands within a pixel of the room available.
  //
  // Measured before anything is drawn, because the face is placed against the text rather than
  // against the canvas: a name and the head beside it are one thing, and centring the two
  // separately would leave whatever was left over as a gap between them.
  const measured = lines.map((line) => {
    ctx.font = `${Math.floor(line.size)}px sans-serif`
    const width = ctx.measureText(line.text).width
    const fitted = width > room ? Math.max(NAMETAG_MIN_PX, line.size * (room / width)) : line.size

    ctx.font = `${Math.floor(fitted)}px sans-serif`
    return { ...line, size: fitted, width: Math.min(ctx.measureText(line.text).width, room) }
  })

  const middle = canvas.width / 2

  if (head) {
    const left = middle - HEADSHOT / 2

    // Nearest neighbour: eight pixels blown up to fifty-six, and anything else is a smear.
    ctx.imageSmoothingEnabled = false
    if (faded) ctx.filter = 'grayscale(1)'
    ctx.drawImage(head, left, HEADSHOT_TOP, HEADSHOT, HEADSHOT)
    ctx.filter = 'none'

    // Ringed the way the letters below are haloed, and in the colour of the box around the body:
    // eight pixels of somebody's skin has no edge of its own against sky, stone or snow, and the
    // colour is the one thing on a label that says whether this is one of ours.
    //
    // The path is inset by half the line so the stroke lands wholly outside the face - centred on
    // its edge, half of it would cover the outermost pixel of the skin, which on a head is an ear.
    ctx.lineWidth = HEADSHOT_OUTLINE
    ctx.strokeStyle = outline
    ctx.strokeRect(
      left - HEADSHOT_OUTLINE / 2,
      HEADSHOT_TOP - HEADSHOT_OUTLINE / 2,
      HEADSHOT + HEADSHOT_OUTLINE,
      HEADSHOT + HEADSHOT_OUTLINE,
    )
  }

  // White on a dark outline rather than plain black: a label has to stay readable over stone,
  // grass, lava and the sky, and no single fill colour does that.
  for (const line of measured) {
    ctx.font = `${Math.floor(line.size)}px sans-serif`
    ctx.lineWidth = Math.max(2, line.size * 0.16)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
    // `maxWidth` is the last resort: a line long enough to reach the floor above is condensed
    // rather than cut, which is ugly and still readable, where a cut drops whole words silently.
    ctx.strokeText(line.text, middle, line.y, room)
    ctx.fillStyle = line.colour
    ctx.fillText(line.text, middle, line.y, room)
  }
}

/** Past anything the world puts in the transparent pass, so a name is never sorted behind a body. */
const NAMETAG_ORDER = 1000

/**
 * The cages a job is drawn with: its box, a plan's, and its pieces still going or done.
 *
 * Crossed with the kind of work — see {@link cageOf} — because a cage says two things at once: what
 * part of a job it is, which the line weight and the dashes carry, and which kind of work it is,
 * which the colour carries.
 */
const CAGES = ['job', 'plan', 'section', 'done'] as const
type CageKind = (typeof CAGES)[number]

/** The key a cage's material is held under: what kind of work, and what part of it. */
function cageOf(type: JobType, kind: CageKind): string {
  return `${type}/${kind}`
}

/** How strongly each is drawn. The pieces fainter than the box they divide. */
const CAGE_OPACITY: Record<CageKind, number> = { job: 0.95, plan: 0.75, section: 0.35, done: 0.6 }

/**
 * The box takes the interface's own accent, so a viewer looks like the rest of Osmium and follows a
 * change of theme without a second place to edit - see {@link Scene.retint}.
 *
 * As a number, which is what three takes. The token is authored in oklch, which three's colour
 * parser does not read, so it is resolved by the browser - see `themeColour` in `lib/theme.ts`.
 */
function themeColour(name: string, fallback: number): number {
  return parseInt(tokenColour(name, '#' + fallback.toString(16).padStart(6, '0')).slice(1), 16)
}

/** The same stand-ins `lib/jobKinds.ts` gives the map, as the number three wants. */
function themeFallback(type: JobType): number {
  return parseInt(JOB_FALLBACK[type].slice(1), 16)
}

/**
 * Stand-ins for the two theme tokens, one each.
 *
 * One shared fallback was fine while there was one box colour. There are two now, and `--color-error`
 * is an `oklch()` value while `--color-primary` is a hex: a browser whose canvas cannot parse the
 * first would have fallen back to a green shared with the second, drawing every box in the fleet
 * colour and saying nothing about it.
 */
const OUTLINE_OURS = 0x4ade80
const OUTLINE_THEIRS = 0xe05252

/**
 * And the third, for a body nobody can see any more.
 *
 * Not a theme token at all. The other two mean "ours" and "theirs" and this one means neither -
 * what it says is that the colour is gone, so it has to be a grey rather than a dimmer version of
 * a thing that means something. Mid enough to read against a night sky and against snow.
 */
const OUTLINE_GONE = 0x9ca3af

/** Which of the three a box is drawn in. */
type Tone = 'ours' | 'theirs' | 'gone'

/** The order {@link Scene.outlineMaterials} is built in, so a tone can pick its own. */
const TONES: readonly Tone[] = ['ours', 'theirs', 'gone']

/**
 * How thick the box is drawn, in pixels.
 *
 * Two rather than three. A box is a hint about where somebody is, and at three the line was wide
 * enough to eat the edges of the body inside it - which is the thing being pointed at.
 */
const OUTLINE_WIDTH = 2

/**
 * How thick a path is drawn, in pixels.
 *
 * Thicker than a box, because it is read at a distance and along its length rather than looked at.
 * A box surrounds something already visible; a line four hundred blocks long is the only thing
 * saying where the agent is headed.
 */
const PATH_WIDTH = 3

/** How much of the line is left where the agent has already walked. */
const PATH_SPENT = 0.3

/**
 * How far above the node a path is drawn.
 *
 * A walk node is where the agent's feet are, which is inside the block it is standing on as far as
 * a line is concerned - drawn at the node itself, most of a path disappears into the floor.
 */
const PATH_LIFT = 0.15

/** How big a node marker is drawn, in pixels. Big enough to find, small enough not to hide the line. */
const NODE_SIZE = 5

/**
 * What a name is drawn onto.
 *
 * Upstream's is 500x100 - two lines of text and nothing else. The face sits above them, so this is
 * taller by exactly the room the face takes, which leaves the text at the size it was: how big a
 * line ends up on screen depends on its pixels and the canvas *width*, and the width has not moved.
 * Tags upstream built are resized to match when they are shaped - see {@link labelOne}.
 */
const NAMETAG_CANVAS = { width: 500, height: 170 }

/**
 * How wide the label is on screen, as world units at unit distance.
 *
 * Not blocks: with size attenuation off, three cancels the perspective divide, so this number is
 * read against the frustum rather than against the world. At a 75 degree field of view it works out
 * near a sixth of the viewport's width, whatever the distance.
 */
const NAMETAG_WIDTH = 0.28

/** How far above the head a label floats, in blocks. Upstream's number, for upstream's tags. */
const NAMETAG_LIFT = 0.6

/** Room left either side of a label for its own outline, in canvas pixels. */
const NAMETAG_MARGIN = 10

/** How small a line may be shrunk before it is condensed instead. Below this nothing is legible. */
const NAMETAG_MIN_PX = 14

function socketUrl(): string {
  const base = import.meta.env['VITE_API_BASE_URL'] || window.location.origin
  return `${base.replace(/^http/, 'ws')}/ws/viewer`
}

/**
 * Everything that arrived before the scene existed, in the order it arrived.
 *
 * Not a reactive ref: it is written to from the socket handler on frames that must not trigger a
 * render, and it is empty again a moment later.
 */
let waiting: ViewerEvent[] = []

/** Whether the scene is being built, so a second `version` frame does not start a second one. */
let building = false

/**
 * Everything remembered about one entity id, dropped together.
 *
 * Ids are reused, so a ruling or a name kept past the thing it described is worse than none: it
 * would be applied to whoever the server issues the id to next.
 */
function forget(current: Scene, id: number): void {
  current.ghosts.delete(id)
  current.seen.delete(id)
  current.names.delete(id)
  current.sizes.delete(id)
  current.undrawable.delete(id)
}

/** Hands one update to the renderer. */
function apply(current: Scene, event: ViewerEvent): void {
  if (event.name === 'position') current.position = event.data as Scene['position']
  if (event.name === 'entity') {
    const entity = event.data as {
      id: number
      name?: string
      username?: string
      width?: number
      height?: number
      pos?: { x: number; y: number; z: number }
      delete?: true
    }

    /*
     * A player the stream drops is kept rather than removed - the removal is simply not passed on,
     * and the body stays exactly where the last update put it. What it is *for* is the question an
     * operator watching an agent actually has: somebody was standing here a minute ago, where.
     *
     * Only players. Everything else the agent can see is either scenery or a mob, and a field of
     * cows nobody can see any more is not a record of anything.
     */
    if (entity.delete && current.seen.get(entity.id) === 'player') {
      current.ghosts.set(entity.id, Date.now())
      // Its box, its skin and its label all change at once, and no further event will arrive for
      // this id to drive that pass - this is the last one.
      shapeNametags(current)
      return
    }

    if (!entity.delete && current.ghosts.has(entity.id)) {
      // A player who walked back into view, under the id they left with. Nothing else to do: the
      // decoration pass below reads `ghosts` and puts the colour back.
      if (!entity.username || entity.username === current.names.get(entity.id)) {
        current.ghosts.delete(entity.id)
      } else {
        // Or somebody else entirely, wearing a reused id. The ghost has to be let go of *before*
        // upstream sees this update, because upstream would otherwise take the body already under
        // that id and simply move it - and the newcomer would arrive wearing a dead player's skin.
        current.emitter.emit('entity', { id: entity.id, delete: true })
        forget(current, entity.id)
      }
    }

    if (entity.name) current.seen.set(entity.id, entity.name)
    if (entity.username) current.names.set(entity.id, entity.username)
    if (entity.width !== undefined && entity.height !== undefined) {
      current.sizes.set(entity.id, { width: entity.width, height: entity.height })
    }
    if (entity.delete) {
      current.sizes.delete(entity.id)
    }
    if (!drawable(current, entity)) return
  }

  current.emitter.emit(event.name, event.data)
  if (event.name === 'entity') shapeNametags(current)
  if (event.name === 'loadChunk') {
    current.received++
    reportCoverage(current)
  }
}

/**
 * Starts the scene over on a world the host has begun streaming afresh.
 *
 * A `version` event is the first thing any stream sends, so a second one means the last stream
 * ended and another has taken its place - a respawn, a dimension change, or an agent that rejoined.
 * The host's new stream keeps no memory of what the old one sent, so it never says `unloadChunk`
 * for any of it: without this every column of every previous life stays in the scene, drawn over
 * whatever is actually there and never freed. An agent that dies a few times drags its old worlds
 * around for the life of the page.
 *
 * Upstream's `resetWorld` is most of the work but leaks in two ways this has to make good: it takes
 * the meshes out of the scene without disposing any of them, and it leaves `loadedChunks` asserting
 * columns that are gone - which then makes it discard the geometry for their replacements, because
 * it checks that map before accepting a mesh.
 */
function restream(current: Scene, world: { version: string; minY?: number; height?: number }): void {
  const renderer = current.viewer.world

  for (const mesh of Object.values(renderer.sectionMeshs ?? {})) mesh?.geometry?.dispose()
  const loaded = renderer.loadedChunks
  if (loaded) for (const key of Object.keys(loaded)) delete loaded[key]

  // In place, because the meshing wrapper holds this very object - see {@link extendMeshedHeight}.
  current.bounds.minY = world.minY ?? 0
  current.bounds.maxY = (world.minY ?? 0) + (world.height ?? 256)

  // Resets the world, re-posts the version and block states to the workers, and clears the
  // entities, which the new stream announces again from scratch.
  current.viewer.setVersion(world.version)

  // Everything remembered about entities describes ids the last stream issued, and ids are reused.
  // The ghosts go with them: `setVersion` empties the scene, so their bodies are already gone.
  current.ghosts.clear()
  current.undrawable.clear()
  current.seen.clear()
  current.names.clear()
  current.sizes.clear()
  current.received = 0

  // A new stream is a new place: a respawn, another dimension, a rejoin. The camera is aimed at the
  // agent afresh when its first position arrives, rather than left looking at where it last was -
  // which after a death is ground the new stream never sends, and reads as an empty world.
  delete current.lastAt
  delete current.shown
  delete current.followed

  console.info(
    `[osmium] viewer restreamed: ${world.version} y ${current.bounds.minY}..${current.bounds.maxY}`,
  )
}

/** Feeds the scene everything it missed while it was being built. */
function replay(): void {
  const current = scene.value
  if (!current) return

  const held = waiting
  waiting = []
  for (const event of held) apply(current, event)
}

async function receive(buffer: ArrayBuffer, socket: WebSocket): Promise<void> {
  let batch
  try {
    batch = await readFrame(buffer)
  } catch (err) {
    // A frame this build cannot read is not a reason to tear the socket down unless it is the
    // layout itself that has moved on, in which case every later frame fails the same way.
    if (err instanceof FrameError) return fail(t('viewer.unsupported'))
    return
  }

  // A socket this screen has since closed or replaced. Its frames describe a stream nobody is on.
  if (socket !== live) return

  for (const event of batch.events) {
    // The host states the version before anything that depends on it, so this is where the scene is
    // built - and rebuilt, if the agent rejoined on a different one.
    if (event.name === 'version') {
      const world = event.data as { version: string; minY?: number; height?: number }

      // A stream that has already been built and is being announced again is a new stream over the
      // same socket. Everything the last one drew is somewhere the agent no longer is.
      if (scene.value) {
        restream(scene.value, world)
        continue
      }

      if (!scene.value && !building) {
        building = true
        try {
          await mount(world, socket)
          replay()
        } catch (err) {
          // The renderer is third-party and loaded on demand, so this is where a missing asset or a
          // module that will not resolve in the browser shows up. Reported rather than left to an
          // unhandled rejection, which is what made this look like a viewer stuck loading forever.
          console.error('[osmium] viewer failed to start', err)
          fail(t('viewer.broken', { reason: err instanceof Error ? err.message : String(err) }))
        }
      }
      continue
    }

    const current = scene.value
    // Held, not dropped. Building the scene means fetching and parsing megabytes of block states,
    // and the host is sending columns throughout - nearest first, so what arrives during that window
    // is exactly the ground the agent is standing on. Discarding it left a hole around the agent
    // that nothing ever filled, in the same place every time.
    if (!current) {
      waiting.push(event)
      continue
    }

    apply(current, event)
  }

  const current = scene.value
  if (!current?.position) return

  frameCamera(current)

  if (firstPerson.value) {
    const { pos, yaw, pitch } = current.position
    current.viewer.setFirstPersonCamera(pos, yaw, pitch)
    return
  }

  showAgent(current)
}

/**
 * Draws the agent's own body, which nothing in the stream describes.
 *
 * The host omits it on purpose - every other entity is something the agent *sees*, and it does not
 * see itself - so the one figure an operator opened this screen to watch is the one that would be
 * missing. Built from the same player model as everyone else and moved by the position updates that
 * are already arriving.
 *
 * Only outside first person, where the camera is inside this mesh and would be looking at the back
 * of its own head.
 */
/**
 * Puts the free camera on the agent when it first appears, and again when it jumps.
 *
 * Nothing else ever aims it. Without this the camera starts at the origin looking at nothing, and
 * an agent that teleports leaves it behind pointing at ground that has since been unloaded - in
 * both cases the world is loaded and meshed and simply off screen, which is why changing camera
 * mode appeared to fix it: that was the only code path that aimed the camera at all.
 *
 * Only on a jump. Following continuously would wrench the view back every time the operator orbited
 * away from a walking agent to look at something.
 */
/**
 * How long the drawn position takes to cover most of the distance to the reported one.
 *
 * Positions arrive coalesced onto a tenth of a second and the view redraws sixty times a second, so
 * an agent drawn where it was last said to be moves in six visible jerks a second - and in follow
 * mode the whole world jerks with it. A little longer than the gap between updates: any shorter and
 * the catching up finishes before the next one lands, which is the stepping back again.
 */
const SETTLE_MS = 120

const TAU = Math.PI * 2

/** An angle folded into the half turn either side of straight ahead. */
function shortestTurn(angle: number): number {
  return ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI
}

/**
 * Moves the drawn position a little of the way towards the reported one.
 *
 * **Per millisecond, not per frame.** The same fraction of the remaining distance every frame
 * smooths twice as hard on a 120Hz screen as on a 60Hz one, which is a look that depends on the
 * monitor. Taking the elapsed time through an exponential gives the same motion on both.
 *
 * A jump is not a walk: a correction bigger than anything an agent could have travelled between two
 * updates is drawn where it actually is, so a teleport does not sail across the world.
 */
function settle(current: Scene, now: number): void {
  const at = current.position?.pos
  const yaw = current.position?.yaw
  if (!at || yaw === undefined) return

  const before = current.drawnAt
  current.drawnAt = now

  const shown = current.shown
  if (!shown || before === undefined || Math.hypot(at.x - shown.x, at.y - shown.y, at.z - shown.z) > TELEPORT) {
    current.shown = { x: at.x, y: at.y, z: at.z, yaw }
    return
  }

  const step = 1 - Math.exp(-(now - before) / SETTLE_MS)

  shown.x += (at.x - shown.x) * step
  shown.y += (at.y - shown.y) * step
  shown.z += (at.z - shown.z) * step
  // The short way round. Yaw wraps, so a turn from just under a half circle to just over it would
  // otherwise be drawn as most of a full one.
  shown.yaw += shortestTurn(yaw - shown.yaw) * step
}

/**
 * Carries the free camera along with the agent.
 *
 * **By the step the agent took, rather than to a fixed place behind it.** Setting the camera to an
 * offset would take the orbit away from whoever is holding it: every drag would be undone on the
 * next frame. Moving both the camera and what it orbits by the same vector leaves the angle and the
 * distance exactly where they were put, and the agent stays in the middle of the screen.
 *
 * The first frame after it is switched on moves nothing - there is no previous position to have
 * stepped from - so the camera stays where it is and simply starts pointing at the agent.
 */
/**
 * Scales a drag and a wheel notch against what is on the screen, once a frame.
 *
 * **Both of upstream's rates are measured from the orbit pivot**, and in this viewer the pivot is
 * stuck to an agent - so zoomed in on one, a drag moves the world by three blocks and a notch by a
 * twentieth of three blocks, while the landscape filling the view is fifty blocks off and barely
 * shifts. Zoomed out the pivot is sixty away and the same gestures move everything. The further
 * in, the less either does, which is backwards.
 *
 * So the depth of whatever is in the middle of the view is measured, and both rates are worked
 * out from that instead - see `orbit.ts` for the arithmetic. A ray down the centre rather than
 * under the pointer, because a rate that changed with the mouse resting somewhere would be its
 * own kind of wonky, and a wheel is turned without the pointer having to be over anything.
 */
function keepControlsUseful(current: Scene): void {
  const controls = current.controls as unknown as
    | { panSpeed: number; target: { x: number; y: number; z: number } }
    | undefined
  if (!controls) return

  const eye = current.viewer.camera.position
  const at = controls.target
  const pivot = Math.hypot(eye.x - at.x, eye.y - at.y, eye.z - at.z)

  controls.panSpeed = panRate(PAN_SPEED, current.depthAt?.(0, 0), pivot)
}

/**
 * Zooms towards the point the camera turns around.
 *
 * **The wheel is still ours** even though the target is upstream’s, because what it does between
 * events is not: a notch is owed rather than spent, and {@link glideZoom} pays it off over the
 * frames that follow. See {@link dollyToward} for the two things that fall out of scaling about a
 * point - arriving slows down, and what is being closed on cannot be zoomed through.
 *
 * It closed on whatever was under the pointer for a while, which is what a modelling tool does. In
 * a viewer whose pivot is a place somebody chose - the middle of the screen, or the agent while
 * following - the cursor is wherever the mouse happens to be resting, and a view that slides off
 * towards it is not what a wheel is for here.
 */
function zoomAtPointer(current: Scene, event: WheelEvent): void {
  const controls = current.controls as unknown as { target: Point & { set(x: number, y: number, z: number): void } } | undefined

  // In first person the camera is the agent, and the orbit is not updated at all - a wheel there
  // would move something nothing puts back.
  if (!controls || firstPerson.value) return

  // The page must not scroll, and the browser must not treat it as a gesture on an ancestor.
  event.preventDefault()

  // Plain zoom slides the camera along its line of sight and leaves the pivot alone, so there is
  // nothing to point at. Ctrl is the one that moves it.
  if (event.ctrlKey || event.metaKey) stirred = performance.now()

  /*
   * **Owed, not spent, and owed against the pivot.**
   *
   * {@link glideZoom} pays it off over the frames that follow, reading the pivot on the frame it
   * spends - so a zoom while following closes on the agent as it is now rather than where it was
   * when the wheel turned. The amount multiplies into whatever is still owed, so a wheel spun in
   * one motion adds up the way it would have if every notch had arrived at once.
   */
  const turned = wheelTurn(event.deltaY, event.deltaX, event.shiftKey)

  // Held at the moment of the turn rather than read while gliding, so letting go of the key
  // half a notch in does not leave the rest of that notch doing something else.
  current.zooming = {
    left: (current.zooming?.left ?? 1) * zoomFactor(turned),
    flying: event.ctrlKey || event.metaKey,
  }
}

/**
 * Spends a frame of whatever zoom the wheel is still owed.
 *
 * The point being closed on is held in the world rather than on the screen, so it stays under the
 * cursor for the whole glide even though the camera is moving the entire time - which is the
 * difference between a camera flying to somewhere and a picture being rescaled.
 *
 * Dropped when there is nothing left to spend, and when a step moved nothing: {@link dollyToward}
 * refuses to go closer than {@link CLOSEST} to what it is aimed at, and an unspendable remainder
 * would otherwise be retried every frame for ever.
 */
function glideZoom(current: Scene): void {
  const zooming = current.zooming
  const controls = current.controls as unknown as
    | { target: Point & { set(x: number, y: number, z: number): void } }
    | undefined
  if (!zooming || !controls) return

  const { step, left } = easeZoom(zooming.left)
  const eye = current.viewer.camera.position

  // The pivot as it is now rather than where it was when the wheel moved, which matters while
  // following: the flight is along the line to the body the camera is watching.
  const moved = dollyToward(eye, controls.target, step, zooming.flying)
  const stalled = moved.camera.x === eye.x && moved.camera.y === eye.y && moved.camera.z === eye.z

  eye.set(moved.camera.x, moved.camera.y, moved.camera.z)
  controls.target.set(moved.target.x, moved.target.y, moved.target.z)

  if (left === 1 || stalled) current.zooming = undefined
  else zooming.left = left
}

function followAgent(current: Scene): void {
  // The drawn position rather than the reported one, so the camera moves with the body it is
  // watching. Following the reported one would step the whole world six times a second under an
  // agent that is gliding, which is worse than either on its own.
  const at = current.shown
  if (!at) return

  const before = current.followed
  current.followed = { x: at.x, y: at.y, z: at.z }

  if (before) {
    const camera = current.viewer.camera.position
    camera.set(camera.x + (at.x - before.x), camera.y + (at.y - before.y), camera.z + (at.z - before.z))
  }

  current.controls?.target.set(at.x, at.y, at.z)
}

function frameCamera(current: Scene): void {
  const at = current.position?.pos
  if (!at) return

  const previous = current.lastAt
  current.lastAt = { x: at.x, y: at.y, z: at.z }

  const jumped =
    !previous || Math.hypot(at.x - previous.x, at.y - previous.y, at.z - previous.z) > TELEPORT
  if (!jumped) return

  current.controls?.target.set(at.x, at.y, at.z)
  current.viewer.camera.position.set(at.x, at.y + 20, at.z + 20)
}

/**
 * How far an agent must move between updates to count as having been put there rather than walked.
 *
 * Positions arrive coalesced onto a tenth of a second, so ordinary movement is a few blocks at
 * most - well inside this, and a sprint or a boat still is.
 */
const TELEPORT = 32

/**
 * Draws where the agent is going, or takes the line away.
 *
 * **Rebuilt rather than updated.** A path arrives whole, and only when it has been drawn or
 * re-planned - the updates in between move the agent along one that has not changed. So this runs a
 * handful of times per journey, and the geometry it throws away is released rather than left for
 * three to collect: a line of several hundred segments is real memory, and a viewer left open
 * through a long walk would accumulate one per re-plan.
 */
/**
 * Puts the box on the block the cursor is over.
 *
 * **Driven from the render loop, not from `pointermove`.** A ray against every loaded section is
 * cheap once a frame and wasteful several times one, and a mouse dragged across a canvas fires
 * pointer events far faster than the screen is redrawn.
 *
 * Frozen while the panel is open: the box is then showing the block that was picked, which is what
 * the panel is about, and letting it wander would leave the two disagreeing.
 */
/**
 * Draws the point the camera turns around, while it is being turned.
 *
 * **The pivot is invisible and everything the camera does is about it**: an orbit swings around
 * it, a pan carries it, and a zoom while following closes on it. Not knowing where it is, is most
 * of why an orbit camera feels arbitrary - the view rotates about somewhere, and which somewhere
 * is a guess until it is drawn.
 *
 * Sized as a share of its distance, so it is the same size on the screen from anywhere, and gone
 * again a moment after the camera stops: see {@link GIMBAL_LINGER}.
 */
function showGimbal(current: Scene): void {
  if (!current.gimbal) {
    const built = current.buildGimbal?.()
    if (!built) return

    current.gimbal = built
    current.viewer.scene.add(built)
  }

  if (!current.ghost) {
    const built = current.buildGhost?.()
    if (built) {
      current.ghost = built
      current.viewer.scene.add(built)
    }
  }

  const cross = current.gimbal
  const ghost = current.ghost
  const controls = current.controls as unknown as { target: Point } | undefined
  const since = performance.now() - stirred

  // Nothing to say while following: the pivot is the agent, the agent is in the middle of the
  // screen, and a cross drawn on it is a mark over the one thing being watched.
  if (!controls || firstPerson.value || follow.value || since > GIMBAL_LINGER + GIMBAL_FADE) {
    cross.visible = false
    if (ghost) ghost.visible = false
    return
  }

  const at = controls.target
  const fading = 1 - Math.max(0, since - GIMBAL_LINGER) / GIMBAL_FADE

  for (const mark of [cross, ghost]) {
    if (!mark) continue

    mark.position.set(at.x, at.y, at.z)
    mark.scale.set(GIMBAL_SPAN, GIMBAL_SPAN, GIMBAL_SPAN)
    mark.visible = true
  }

  // The solid half is the whole of what the mark is when nothing is in the way, so the dashed one
  // is kept under it rather than adding to it.
  const solid = (cross as unknown as { material?: { opacity: number } }).material
  if (solid) solid.opacity = fading

  const faint = (ghost as unknown as { material?: { opacity: number } } | undefined)?.material
  if (faint) faint.opacity = fading * GHOST_SHARE
}

function showHover(current: Scene): void {
  if (!current.hover) {
    const built = current.buildHover?.()
    if (!built) return

    current.hover = built
    current.viewer.scene.add(built)
  }

  const box = current.hover
  const over = current.over

  /*
   * **A picked block outlives the cursor that picked it.**
   *
   * Reaching for the panel takes the pointer off the canvas, which clears {@link Scene.over} -
   * and the outline went with it, so the one moment the box is doing its most useful work, saying
   * which block the menu is about, was the one moment it was not drawn. What is under the cursor
   * only matters while nothing has been chosen.
   */
  const at = picked.value ?? (over && current.pick?.(over.nx, over.ny))

  if (!at || firstPerson.value) {
    box.visible = false
    return
  }

  // The middle of the cell, because a box is one block wide and centred on its own origin.
  box.position.set(at.x + 0.5, at.y + 0.5, at.z + 0.5)
  box.visible = true
}

/**
 * Where the fleet's work stands in the world this agent is in: jobs solid, plans dashed, each in
 * the colour of its kind.
 *
 * The same list the map draws, from the same arithmetic — `lib/buildBoxes.ts` — so a box here and
 * a box there are the same box. Only the agent's own server and world: the same coordinates in
 * another one are somewhere else entirely.
 */
const placedBoxes = computed<PlacedBox[]>(() => {
  const server = agent.value?.serverAddress
  const world = agent.value?.telemetry?.dimension
  if (!server || !world) return []

  return buildBoxes(agentStore.plans, agentStore.jobs, server, world, agentStore.regions)
})

/**
 * Brings the scene's cages in line with {@link placedBoxes}.
 *
 * Every frame, and cheap for it: a handful of boxes compared by a key, and geometry only built for
 * one that is new or has moved. See {@link Scene.builds} for why moving one is a rebuild.
 */
function showBuilds(current: Scene): void {
  const held = (current.builds ??= new Map())
  const wanted = new Set<string>()

  // A job's pieces are cages of their own inside its box, keyed under it so they go when it does.
  const cages = placedBoxes.value.flatMap((placed) => [
    {
      id: placed.id,
      box: placed.box,
      kind: (placed.planned ? 'plan' : 'job') as CageKind,
      type: placed.type,
    },
    ...placed.sections.map((section, at) => ({
      id: `${placed.id}/${at}`,
      box: section.box,
      kind: (section.done ? 'done' : 'section') as CageKind,
      type: placed.type,
    })),
  ])

  for (const cage of cages) {
    wanted.add(cage.id)
    const { west, east, north, south, low, high } = cage.box
    const key = `${west},${east},${north},${south},${low},${high},${cage.type},${cage.kind}`

    const existing = held.get(cage.id)
    if (existing?.key === key) continue
    if (existing) current.viewer.scene.remove(existing.mesh)

    const mesh = current.buildCage?.(cage.box, cage.kind, cage.type)
    if (!mesh) continue
    current.viewer.scene.add(mesh)
    held.set(cage.id, { mesh, key })
  }

  for (const [id, { mesh }] of held) {
    if (wanted.has(id)) continue
    current.viewer.scene.remove(mesh)
    held.delete(id)
  }
}

/**
 * Puts a box on every block the route still means to change.
 *
 * **Blocks, not standing positions.** These arrive as the squares themselves, so they are centred
 * the way the hover box is and not lifted the way the path line is - see `standsAt` on the host for
 * the half-block that separates the two.
 */
function showWork(current: Scene, work: ReadonlyArray<{ x: number; y: number; z: number }>): void {
  for (const box of current.workBoxes ?? []) {
    current.viewer.world.scene.remove(box)
    disposeGeometry(box)
  }
  current.workBoxes = undefined

  if (work.length === 0) return

  const built: Mesh[] = []

  for (const spot of work) {
    const box = current.buildWork?.()
    if (!box) break

    // The middle of the cell, because a box is one block wide and centred on its own origin.
    box.position.set(spot.x + 0.5, spot.y + 0.5, spot.z + 0.5)
    current.viewer.scene.add(box)
    built.push(box)
  }

  if (built.length) current.workBoxes = built
}

function showPath(current: Scene, nodes: ReadonlyArray<{ x: number; y: number; z: number }>, progress: number): void {
  for (const line of current.pathLines ?? []) {
    current.viewer.world.scene.remove(line)
    disposeGeometry(line)
  }
  current.pathLines = undefined

  if (nodes.length < 2) return

  // Split at the node the agent has reached, and shared with it: the segment being walked belongs to
  // both halves, or the line has a gap in it exactly where the eye is.
  const at = Math.min(Math.max(progress, 0), nodes.length - 1)
  const halves: Array<{ from: number; to: number; spent: boolean }> = [
    { from: 0, to: at, spent: true },
    { from: at, to: nodes.length - 1, spent: false },
  ]

  /*
   * Everything is drawn relative to the first node rather than at its own coordinates.
   *
   * **A vertex is a 32-bit float, and these are far from the origin.** Out where this fleet plays,
   * half a million blocks, that leaves about a sixteenth of a block between one representable
   * position and the next - so a line drawn at absolute coordinates lands on a slightly different
   * spot each frame as the camera moves, and the whole route shimmers over a world that does not.
   *
   * three works the model-view matrix out in double precision on the processor and hands the shader
   * the combined result, so the large part of the position is carried exactly by the matrix and only
   * the small remainder ever reaches a float. The world itself is steady for the same reason: every
   * chunk section is built around its own corner and placed.
   *
   * Floored so the anchor is a whole block, which keeps the remainders the same from one redraw to
   * the next.
   */
  const first = nodes[0]!
  const anchor = { x: Math.floor(first.x), y: Math.floor(first.y), z: Math.floor(first.z) }

  const built: Mesh[] = []

  for (const half of halves) {
    const points: number[] = []
    const dots: number[] = []

    for (let index = half.from; index <= half.to; index++) {
      const node = nodes[index]!
      dots.push(node.x - anchor.x, node.y + PATH_LIFT - anchor.y, node.z - anchor.z)

      const next = nodes[index + 1]
      if (index === half.to || !next) continue

      points.push(
        node.x - anchor.x, node.y + PATH_LIFT - anchor.y, node.z - anchor.z,
        next.x - anchor.x, next.y + PATH_LIFT - anchor.y, next.z - anchor.z,
      )
    }

    for (const piece of [current.buildPath?.(points, half.spent, anchor), current.buildNodes?.(dots, half.spent, anchor)]) {
      if (!piece) continue

      current.viewer.scene.add(piece)
      built.push(piece)
    }
  }

  if (built.length) current.pathLines = built
}

function showAgent(current: Scene): void {
  const { pos, yaw } = current.position ?? {}
  if (!pos || yaw === undefined) return

  if (!current.body) {
    const built = current.buildBody?.()
    if (!built) return
    current.body = built
    unskin(built)
    built.visible = !firstPerson.value
    current.viewer.scene.add(built)

    // The agent's own skin, box and nametag. All three are done here rather than by the pass that
    // decorates everybody else, because this body is not one of the streamed entities - the host
    // omits the agent from its own view, so nothing in `viewer.entities` describes it.
    const own = agent.value?.mcUsername
    if (own) skin(current, built, own)

    outlineOne(current, built, 'ours', SELF)
    const tag = current.buildNametag?.(SELF.height)
    if (tag) built.add(tag)
  }

  // Every update the agent moves, so its own label keeps up with its own vitals the way the others
  // do. Not per frame: it redraws a canvas, and sixty of those a second is a texture upload for a
  // number that changes once a second.
  labelOne(current, current.body, agent.value?.mcUsername ?? undefined, 'ours')
}

/**
 * Puts the body where it is drawn, which is a frame's job rather than an update's.
 *
 * Split off {@link showAgent} because the two run at different rates. Building the mesh, fetching
 * the skin and redrawing the label belong to an update; where it stands belongs to the frame, or
 * the smoothing in {@link settle} would have nothing to show for itself.
 */
function placeAgent(current: Scene): void {
  const shown = current.shown
  if (!current.body || !shown) return

  current.body.position.set(shown.x, shown.y, shown.z)
  current.body.rotation.y = shown.yaw
}

/**
 * The agent's own hitbox, which nothing on the wire describes.
 *
 * The stream carries a width and height for every entity *except* this one - the host leaves the
 * agent out of its own view - so the box around it is sized from what a player is.
 */
const SELF = { width: 0.6, height: 1.8 }

/**
 * Builds the renderer and points it at Osmium's copy of the assets.
 *
 * Upstream resolves three things by bare relative path, against whatever URL the page happens to
 * be at - which works for its own single-page server and for nothing else:
 *
 * - the meshing **worker**, `new Worker('worker.js')`, which cannot be configured at all. The
 *   constructor is swapped for the moment the workers are made, and put straight back.
 * - the block **atlas** and **states**, which can: both have a settable field, so they are handed
 *   over directly and the relative path is never used.
 * - **entity** textures, which cannot - but every one of them goes through a three.js loader, so
 *   the loading manager rewrites them centrally.
 *
 * And `supportedVersions` is appended to rather than patched: `getVersion` returns an exact match
 * before it consults the majors table, so pushing the version is enough to have it accepted.
 */
/**
 * The staged version list, as a token that changes whenever the mesher is rebuilt.
 *
 * The mesher is one bundle carrying the data for every staged version, so staging rewrites it - at
 * the same path, which the browser has every right to answer from its cache. The old bundle then
 * starts, takes a version it has no data for, and throws inside a worker where nothing is
 * listening; the first section to be meshed fails several messages later with
 * `Cannot read properties of null (reading 'getColumn')`, naming nothing to do with versions.
 */
async function mesherStamp(): Promise<string> {
  try {
    const stamp = await fetch(`${ASSETS}/worker.versions.json`, { cache: 'no-store' })
    const listed = (await stamp.json()) as string[]
    return listed.join('-')
  } catch {
    return 'unknown'
  }
}

async function mount(world: { version: string; minY?: number; height?: number }, socket: WebSocket): Promise<void> {
  const version = world.version

  // Before the renderer is loaded, not after. `viewer/lib/utils.js` serves both upstream's Node
  // renderer and the browser, and picks between them by reading `process.platform` at call time -
  // with no `process` at all it throws on the first texture instead of handing over to the
  // `utils.web.js` beside it. Upstream's webpack build provides `process/browser` for this; a bare
  // `define` cannot, because Vite pre-bundles this dependency and does not apply defines to that
  // pass. Set here rather than globally so nothing else in the app inherits a fake Node.
  const shim = globalThis as { process?: { platform: string; env: Record<string, string>; versions: Record<string, string> } }
  shim.process ??= { platform: 'browser', env: {}, versions: {} }

  const THREE = await import('three')
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')
  const { Viewer, Entity, supportedVersions } = await import('prismarine-viewer/viewer')
  const { LineSegments2 } = await import('three/examples/jsm/lines/LineSegments2.js')
  const { LineSegmentsGeometry } = await import('three/examples/jsm/lines/LineSegmentsGeometry.js')
  const { LineMaterial } = await import('three/examples/jsm/lines/LineMaterial.js')

  // `viewer/lib/entity/Entity.js` reads a global `THREE` rather than importing one, so without this
  // every entity throws on construction and nothing with a body is ever drawn. Upstream's own
  // client sets exactly this before it builds a viewer.
  ;(globalThis as { THREE?: unknown }).THREE ??= THREE

  if (!supportedVersions.includes(version)) supportedVersions.push(version)

  // Which versions the mesher on disk was built for. Its own URL never changes, so this is what
  // tells one bundle from the next - see the worker constructor below.
  const stamp = await mesherStamp()

  THREE.DefaultLoadingManager.setURLModifier((url: string) =>
    url.startsWith('textures/') || url.startsWith('blocksStates/') ? `${ASSETS}/${url}` : url,
  )

  const element = canvas.value
  if (!element) return

  const renderer = new THREE.WebGLRenderer({ canvas: element })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(element.clientWidth, element.clientHeight, false)

  const native = window.Worker
  window.Worker = class extends native {
    constructor(url: string | URL, options?: WorkerOptions) {
      /*
       * Stamped, because the bundle changes and its URL does not.
       *
       * The mesher is one bundle carrying the data for every staged version, so staging a new one
       * rewrites it - at the same path, which the browser has every right to answer from its cache.
       * The old bundle then starts, takes a version it has no data for, and throws inside a worker
       * where nothing is listening; the first section to be meshed fails several messages later with
       * `Cannot read properties of null (reading 'getColumn')`, naming nothing to do with versions.
       */
      super(url === 'worker.js' ? `${ASSETS}/worker.js?built=${stamp}` : url, options)
    }
  }
  let viewer: ViewerLike
  try {
    viewer = new Viewer(renderer) as ViewerLike
  } finally {
    window.Worker = native
  }

  // Both of the next two reach past the public surface because `Viewer` builds its `WorldRenderer`
  // itself and passes nothing through: the worker count is a constructor default, and the handler
  // that turns a worker's reply into a mesh is assigned inside that constructor.

  // Before `setVersion`, so a worker about to be dropped is never given a world to hold. Everything
  // upstream does with the pool reads `this.workers` as it goes, its length included.
  for (const surplus of viewer.world.workers.splice(WORKERS)) surplus.terminate()

  for (const worker of viewer.world.workers) {
    const built = worker.onmessage
    worker.onmessage = (event) => {
      built?.(event)
      // After upstream has built the mesh and put it in the scene, before three has drawn it.
      if (event.data.type === 'geometry') settleGeometry(viewer.world.sectionMeshs?.[event.data.key ?? ''])
    }
  }

  // Removed bodies are freed all the way down, which upstream's own removal does not - see `release`.
  const bodies = viewer.entities as unknown as {
    entities: Record<string, unknown>
    update(entity: { id: number; delete?: true }): void
    clear(): void
  }
  const updateBody = bodies.update.bind(bodies)
  bodies.update = (entity) => {
    const leaving = entity.delete ? bodies.entities[entity.id] : undefined
    updateBody(entity)
    release(leaving)
  }
  const clearBodies = bodies.clear.bind(bodies)
  bodies.clear = () => {
    const leaving = Object.values(bodies.entities)
    clearBodies()
    for (const body of leaving) release(body)
  }

  viewer.world.texturesDataUrl = `${ASSETS}/textures/${version}.png`

  /*
   * **A 404 is not the only way this file can be absent.**
   *
   * Vite answers a missing path under the site root by serving `index.html`, because that is what a
   * single-page app needs of a dev server - so an unstaged version comes back 200 with a page in it,
   * the status check passes, and the failure surfaces several frames later as
   * `Unexpected token '<', "<!doctype "... is not valid JSON`. Which is a true statement about a
   * string and tells nobody anything about Minecraft versions.
   *
   * So the body is what decides, not the status: something that will not parse as JSON is something
   * that is not the block states, whichever of the two ways it went missing.
   */
  const states = await fetch(`${ASSETS}/blocksStates/${version}.json`)
  if (!states.ok) return fail(t('viewer.unstaged', { version }))

  try {
    viewer.world.blockStatesData = await states.json()
  } catch {
    return fail(t('viewer.unstaged', { version }))
  }

  if (!viewer.setVersion(version)) return fail(t('viewer.unstaged', { version }))

  // Before anything is listened for, so the very first column is meshed over its whole height.
  // Defaults are the pre-1.18 range, which is what a server that does not state its bounds is.
  const bounds = {
    minY: world.minY ?? 0,
    maxY: (world.minY ?? 0) + (world.height ?? 256),
  }
  extendMeshedHeight(viewer.world, bounds)

  const emitter = new Emitter()
  viewer.listen(emitter)

  // Upstream reaches for the global `THREE.OrbitControls` its own bundle attaches; the module is
  // the same class, imported the way the rest of this app imports anything.
  const controls = new OrbitControls(viewer.camera as never, element)

  /*
   * **Panning in the plane of the screen, at a fixed rate.**
   *
   * Upstream works the pan out against the distance from the camera to whatever it is orbiting - so
   * a view pushed far out over a landscape, with its target still on an agent right in front of it,
   * pans at the rate of something an arm's length away. The further out the less it moves, which is
   * the opposite of what dragging a picture should feel like.
   *
   * `screenSpacePanning` moves along the camera's own axes rather than the ground plane, so a drag
   * takes the world with the cursor whichever way the view is tilted.
   */
  // Both are set by the class and neither is in its type declarations, which describe an older
  // shape than the code in the same package. Narrowed to the two fields rather than cast away
  // wholesale, so everything else about the controls stays typed.
  const panning = controls as unknown as {
    screenSpacePanning: boolean
    panSpeed: number
    enableZoom: boolean
    enableDamping: boolean
    dampingFactor: number
  }
  panning.screenSpacePanning = true
  panning.panSpeed = PAN_SPEED

  /*
   * **The wheel is ours**, because zooming towards the pointer is a different move from the one
   * upstream makes - see {@link zoomAtPointer}. Left on, both would run against the same event.
   */
  panning.enableZoom = false

  // Every drag and orbit eases to a stop rather than ending on the frame the button comes up.
  // `update` is already called every frame, which is what damping needs.
  panning.enableDamping = true
  panning.dampingFactor = SETTLING

  // Two of them are the two the map paints its markers with: the fleet in `--color-primary` and
  // everybody else in `--color-error`. The third is nobody's, and is not a theme colour at all -
  // see `OUTLINE_GONE`.
  //
  // Resolved once, here, because two things are drawn in them: the box around a body and the ring
  // around the face on its label. Resolving the tokens twice is two chances for the same player to
  // be outlined in two colours.
  const toneColours = (): Record<Tone, number> => ({
    ours: themeColour('--color-primary', OUTLINE_OURS),
    theirs: themeColour('--color-error', OUTLINE_THEIRS),
    gone: OUTLINE_GONE,
  })
  const tones = toneColours()

  // As CSS, for the canvas a label's face is ringed on.
  const cssTones = (from: Record<Tone, number>) =>
    Object.fromEntries(TONES.map((tone) => [tone, '#' + from[tone].toString(16).padStart(6, '0')])) as Record<
      Tone,
      string
    >

  // A width is measured in pixels, so each has to be told the size of the canvas - see `resize`.
  // Built in the order `TONES` names them, which is how `buildOutline` finds one.
  const outlineMaterials = TONES.map(
    (tone) =>
      new LineMaterial({
        color: tones[tone],
        linewidth: OUTLINE_WIDTH,
        depthTest: false,
        transparent: true,
      }),
  )
  for (const material of outlineMaterials) material.resolution.set(element.clientWidth, element.clientHeight)

  // The fleet's own colour, which is what the map draws a path in too. Depth-tested off for the
  // same reason the boxes are: a route is worth seeing through the hill it goes round.
  const pathMaterials = [false, true].map(
    (spent) =>
      new LineMaterial({
        color: tones.ours,
        linewidth: PATH_WIDTH,
        depthTest: false,
        transparent: true,
        opacity: spent ? PATH_SPENT : 1,
      }),
  )
  for (const material of pathMaterials) material.resolution.set(element.clientWidth, element.clientHeight)

  // One dot per node, in the same colour as the line through them. A fixed pixel size rather than a
  // world size: a node is a fact about the route, not a thing in the world, and one drawn to scale
  // is a speck at the far end of a long path and a boulder at the near end.
  const nodeMaterials = [false, true].map(
    (spent) =>
      new THREE.PointsMaterial({
        color: tones.ours,
        size: NODE_SIZE,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: spent ? PATH_SPENT : 1,
      }),
  )

  const raycaster = new THREE.Raycaster()

  /**
   * The first block a ray through a point on the screen touches.
   *
   * **Only the world's own meshes**, for the reason `pick` gives: the bodies, the nametags and
   * the outlines are drawn with depth testing off, so casting against the whole scene answers
   * with something floating in front of the terrain rather than the terrain.
   *
   * The one cast the depth, the aim and the pivot are all read out of - they were three copies of
   * it, and three copies of a thing like this is three chances for them to disagree about what
   * the camera is looking at.
   */
  const groundAt = (nx: number, ny: number): Point | undefined => {
    raycaster.setFromCamera({ x: nx, y: ny } as never, viewer.camera as never)

    const world = Object.values(viewer.world.sectionMeshs ?? {}).filter((mesh) => mesh !== undefined)
    const hit = raycaster.intersectObjects(world as never[], false)[0] as { point: Point } | undefined

    return hit?.point
  }

  // The page's own text colour, which is what vanilla's own selection box amounts to: a neutral
  // that is not one of the two colours already meaning "ours" and "theirs".
  const hoverMaterial = new LineMaterial({
    color: themeColour('--color-base-content', 0x111111),
    linewidth: 2.5,
    // Depth tested, unlike the boxes around bodies. A selection box that showed through the hill in
    // front of it would say the cursor was on something it is not.
    depthTest: true,
    transparent: true,
    opacity: 0.9,
  })
  hoverMaterial.resolution.set(element.clientWidth, element.clientHeight)

  // The accent, because this is the only mark on the screen that is about the camera rather than
  // about the world.
  //
  // Depth tested, like the hover cursor and unlike the boxes around bodies. Drawn through the
  // world it reads as floating in front of whatever is actually there, which is the one thing a
  // mark saying "here" must not do - and now that it only appears while it is being moved, being
  // occluded says something useful in itself: the pivot has gone behind something.
  const gimbalMaterial = new LineMaterial({
    color: themeColour('--color-accent', 0x38bdf8),
    // Heavier than the outlines around bodies: those sit on something, and this is a bare cross in
    // open air with a world of edges behind it to be lost among.
    linewidth: 3.5,
    depthTest: true,
    transparent: true,
    opacity: 0,
  })
  gimbalMaterial.resolution.set(element.clientWidth, element.clientHeight)

  /*
   * **The same cross again, for the part of it that is behind something.**
   *
   * Depth testing alone answers the wrong question. Drawn through the world the pivot floats in
   * front of walls it is nowhere near; drawn behind them it vanishes outright, and a mark that
   * disappears exactly when it is furthest from obvious is not much of a mark. So it is drawn
   * twice - solid where there is a clear line to it, dashed where there is not - and the break
   * between the two says where the surface in front of it is.
   *
   * Thinner and fainter, because this half is a hint about something out of sight rather than a
   * thing being pointed at.
   */
  const ghostMaterial = new LineMaterial({
    color: themeColour('--color-accent', 0x38bdf8),
    linewidth: 2,
    // Every arm is half a block, so a dash and a gap of a tenth reads as a dash rather than as a
    // line somebody nicked.
    dashed: true,
    dashSize: 0.1,
    gapSize: 0.1,
    depthTest: false,
    transparent: true,
    opacity: 0.45,
  })
  ghostMaterial.resolution.set(element.clientWidth, element.clientHeight)

  // Green, and the page's own if it has one: this is the only marker on the map that means
  // "about to happen" rather than "is", and it should not be mistakable for either agent colour.
  const workMaterial = new LineMaterial({
    color: themeColour('--color-success', 0x22c55e),
    linewidth: 1.5,
    depthTest: true,
    transparent: true,
    opacity: 0.9,
  })
  workMaterial.resolution.set(element.clientWidth, element.clientHeight)

  /*
   * **Where builds stand: solid for a job, dashed for a plan**, in the colour building has
   * everywhere else — an agent's badge, a job's bar — so a cage reads as "a build" before anybody
   * works out which.
   *
   * Depth tested. A build's box is a thing in the world with a hill in front of it, and drawn through
   * everything it would be a frame floating over the whole view rather than ground an agent works on.
   */
  //
  // A job's pieces are cages inside its box: thinner and fainter, so the division reads as the inside
  // of one build rather than as several, and a finished piece a little stronger than one still going.
  const buildMaterials = new Map<string, InstanceType<typeof LineMaterial>>(
    JOB_TYPES.flatMap((type) =>
      CAGES.map((kind): [string, InstanceType<typeof LineMaterial>] => [
        cageOf(type, kind),
        new LineMaterial({
          color: themeColour(jobInk(type), themeFallback(type)),
          linewidth: kind === 'job' ? 2 : kind === 'plan' ? 1.5 : 1,
          // A block is the unit here, so a dash of one and a gap of a half reads as a dashed edge on
          // a build of any size — the cage is built at its real size for exactly this.
          dashed: kind === 'plan',
          dashSize: 1,
          gapSize: 0.5,
          depthTest: true,
          transparent: true,
          opacity: CAGE_OPACITY[kind],
        }),
      ]),
    ),
  )
  for (const material of buildMaterials.values()) {
    material.resolution.set(element.clientWidth, element.clientHeight)
  }

  const models = await import('prismarine-viewer/viewer/lib/entity/entities.json')
  const built: Scene = {
    viewer,
    emitter,
    socket,
    renderer,
    controls,
    frame: 0,
    models: buildableModels((models.default ?? models) as never),
    undrawable: new Set(),
    // The version is upstream's fixed one for entities, not the server's - that is the only set of
    // entity models the renderer ships textures for.
    buildBody: () => new Entity('1.16.4', 'player', viewer.scene).mesh as Mesh,
    /**
     * The body a slim skin needs, for swapping in once one turns up. See `dress`.
     *
     * Undefined rather than throwing when the model is missing — which is what a build that skipped
     * `viewer-assets` looks like. A slim skin on wide arms is a pixel wrong; a skin that never
     * arrives because building the body threw is the whole feature gone.
     */
    buildSlim: () => {
      try {
        return new Entity('1.16.4', SLIM, viewer.scene).mesh as Mesh
      } catch (err) {
        console.warn('[osmium] no slim player model; run the viewer-assets step', err)
        return undefined
      }
    },
    /**
     * A skin as a texture, set up exactly as upstream sets up the one it replaces.
     *
     * Built here rather than cloned from the model's own, because upstream hands the same
     * `THREE.Texture` to every entity naming the same file - `loadTexture` keeps a cache - so the
     * texture on a player belongs to every player and to the agent's own body.
     */
    buildTexture: (image: HTMLCanvasElement) => {
      const texture = new THREE.CanvasTexture(image)
      // Minecraft's own sampling: a 64-pixel sheet on a model this size is magnified heavily, and
      // anything but nearest turns a face into a smear.
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      // The model's UVs are written for a sheet whose origin is the top left, which is the opposite
      // of what three assumes.
      texture.flipY = false
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.needsUpdate = true
      // Built for one body, so freed with it - see `release`. The renderer's cached sheets are not.
      ownedTextures.add(texture)
      return texture as unknown as TextureLike
    },
    // In world units, not model units: what an entity is attached to is a plain Object3D, and the
    // sixteenth-scale lives on its children. Scaling for it here made everything sixteen times its
    // size.
    buildOutline: (width: number, height: number, tone: Tone) => {
      const box = new THREE.BoxGeometry(width, height, width)
      // The model stands on its origin, so the box is raised to sit around it rather than straddle.
      box.translate(0, height / 2, 0)

      // `LineSegments2` rather than `LineSegments`: `linewidth` is inert on a plain line material -
      // WebGL draws every line one pixel wide whatever it says - and this one builds the segments
      // out of quads instead, so a width is actually a width.
      const outline = new LineSegments2(
        new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(box)),
        outlineMaterials[TONES.indexOf(tone)],
      ) as unknown as Mesh
      outline.renderOrder = NAMETAG_ORDER
      outline.frustumCulled = false
      // Named so the pass that owns nametags leaves it alone.
      outline.userData['osmiumOutline'] = true
      return outline
    },
    /**
     * Which block somebody pointed at.
     *
     * **Only the world's own meshes.** Casting against the whole scene would hit the bodies, the
     * nametag sprites, the boxes around players and the path lines - and the last three are drawn
     * with depth testing off, so they win against terrain they are behind and a click near an agent
     * would answer with a point floating in the air in front of it.
     *
     * The half-block step along the face normal is what turns the surface into somewhere to stand:
     * the ray lands exactly on the boundary between the ground and the air above it, and flooring
     * that raw is a coin toss between the two.
     */
    /**
     * How far the camera is from the world at a point on the screen.
     *
     * The same cast as {@link Scene.pick} and against the same meshes, answering the distance
     * rather than the block - which is what a gesture should be scaled by, and is not the same as
     * the distance to whatever the camera happens to be orbiting. Nothing when the ray leaves the
     * world, which is the sky.
     */
    depthAt: (nx: number, ny: number) => {
      const on = groundAt(nx, ny)
      if (!on) return undefined

      const eye = viewer.camera.position
      return Math.hypot(eye.x - on.x, eye.y - on.y, eye.z - on.z)
    },
    pick: (nx: number, ny: number) => {
      raycaster.setFromCamera({ x: nx, y: ny } as never, viewer.camera as never)

      const world = Object.values(viewer.world.sectionMeshs ?? {}).filter((mesh) => mesh !== undefined)
      const hit = raycaster.intersectObjects(world as never[], false)[0] as
        | { point: { x: number; y: number; z: number }; face?: { normal: { x: number; y: number; z: number } } }
        | undefined

      if (!hit) return undefined

      const away = hit.face?.normal ?? { x: 0, y: 0, z: 0 }
      return {
        x: Math.floor(hit.point.x + away.x * 0.5),
        y: Math.floor(hit.point.y + away.y * 0.5),
        z: Math.floor(hit.point.z + away.z * 0.5),
      }
    },
    /**
     * Corners rather than a cage - see `reticle.ts`.
     *
     * The middle of each edge is left open, which matters more here than anywhere else on the
     * screen: every edge of a full wireframe lands on an edge the world already has, so the box
     * that is meant to say where the cursor is disappears into the block it is on.
     */
    buildHover: () => {
      const line = new LineSegments2(
        new LineSegmentsGeometry().setPositions(cornerArms()),
        hoverMaterial,
      ) as unknown as Mesh

      line.frustumCulled = false
      line.visible = false
      return line
    },
    /**
     * A whole cage at the build's real size, rather than a unit one scaled: a plan's is dashed, and
     * a dash is measured along the line, so scaling would stretch the dashes with the box.
     *
     * Inclusive at both ends, so the far corner is one past the last block in every direction.
     */
    buildCage: (box: PlacedBox['box'], kind: CageKind, type: JobType) => {
      const wide = box.east - box.west + 1
      const tall = box.high - box.low + 1
      const deep = box.south - box.north + 1
      const unit = cubeEdges()
      const sized = unit.map((value, at) => value * [wide, tall, deep][at % 3]!)

      const line = new LineSegments2(
        new LineSegmentsGeometry().setPositions(sized),
        buildMaterials.get(cageOf(type, kind))!,
      ) as unknown as Mesh

      // A dashed line is drawn from how far along itself each vertex is, which nothing works out on
      // its own - see the ghost cross below.
      if (kind === 'plan') (line as unknown as { computeLineDistances(): void }).computeLineDistances()

      line.position.set(box.west, box.low, box.north)
      line.frustumCulled = false
      return line
    },
    buildGimbal: () => {
      const line = new LineSegments2(
        new LineSegmentsGeometry().setPositions(axisCross()),
        gimbalMaterial,
      ) as unknown as Mesh

      /*
       * **Last in the transparent pass, whatever the camera thinks the order should be.**
       *
       * The same fault the nametags have, and for the same reason - see {@link NAMETAG_ORDER}.
       * Everything drawn through the world here is transparent, so three sorts it all back to
       * front by distance, and orbiting swaps which of any two is nearer. For the half of a turn
       * where an outline or a route sorted later than this, it was drawn over the top and the
       * pivot simply was not there. Depth testing does not answer it either: that settles what the
       * world hides, and this is about two overlays arriving in the wrong order.
       */
      line.renderOrder = NAMETAG_ORDER
      line.frustumCulled = false
      line.visible = false
      return line
    },
    buildGhost: () => {
      const line = new LineSegments2(
        new LineSegmentsGeometry().setPositions(axisCross()),
        ghostMaterial,
      ) as unknown as Mesh

      // A dashed line is drawn from how far along itself each vertex is, which nothing works out
      // on its own: without this the whole cross comes out solid and the two halves are one.
      ;(line as unknown as { computeLineDistances(): void }).computeLineDistances()

      // Behind the solid one in the transparent pass, for the same reason it is ordered at all.
      line.renderOrder = NAMETAG_ORDER - 1
      line.frustumCulled = false
      line.visible = false
      return line
    },
    buildWork: () => {
      const box = new THREE.BoxGeometry(1, 1, 1)
      const line = new LineSegments2(
        new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(box)),
        workMaterial,
      ) as unknown as Mesh

      line.frustumCulled = false
      return line
    },
    buildPath: (points: number[], spent: boolean, anchor: { x: number; y: number; z: number }) => {
      // Six floats is one segment. Fewer than that is a path with nowhere to go.
      if (points.length < 6) return undefined

      const geometry = new LineSegmentsGeometry()
      geometry.setPositions(points)

      const line = new LineSegments2(geometry, pathMaterials[spent ? 1 : 0]) as unknown as Mesh
      line.renderOrder = NAMETAG_ORDER
      line.frustumCulled = false
      line.position.set(anchor.x, anchor.y, anchor.z)
      return line
    },
    buildNodes: (points: number[], spent: boolean, anchor: { x: number; y: number; z: number }) => {
      if (points.length < 3) return undefined

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))

      const dots = new THREE.Points(geometry, nodeMaterials[spent ? 1 : 0]) as unknown as Mesh
      dots.renderOrder = NAMETAG_ORDER
      dots.frustumCulled = false
      dots.position.set(anchor.x, anchor.y, anchor.z)
      return dots
    },
    /**
     * A nametag for a body the stream never announced.
     *
     * Upstream builds one only inside `getEntityMesh`, and only when the update carries a username -
     * which the agent's own body, built straight from `Entity`, never gets. Same canvas size as
     * upstream's so `redrawNametag` and the shaping pass need no second case.
     */
    buildNametag: (height: number) => {
      const label = document.createElement('canvas')
      label.width = NAMETAG_CANVAS.width
      label.height = NAMETAG_CANVAS.height

      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(label) }),
      ) as unknown as Mesh
      // Over the head rather than through it, the height upstream uses for everybody else.
      sprite.position.set(0, height + NAMETAG_LIFT, 0)
      return sprite
    },
    filters: { linear: THREE.LinearFilter, clamp: THREE.ClampToEdgeWrapping },
    bounds,
    received: 0,
    outlineMaterials,
    markerMaterials: [
      hoverMaterial,
      gimbalMaterial,
      ghostMaterial,
      workMaterial,
      ...buildMaterials.values(),
    ],
    pathMaterials: [...pathMaterials, hoverMaterial],
    seen: new Map(),
    names: new Map(),
    sizes: new Map(),
    ghosts: new Map(),
    heads: new Map(),
    tones: cssTones(tones),
    retint: () => {
      // Every one of these has a `color`; the line material's typings simply do not declare it.
      const tint = (material: unknown, colour: number) =>
        (material as { color: { set(value: number): void } }).color.set(colour)

      const next = toneColours()
      outlineMaterials.forEach((material, at) => tint(material, next[TONES[at]!]))
      for (const material of [...pathMaterials, ...nodeMaterials]) tint(material, next.ours)
      tint(hoverMaterial, themeColour('--color-base-content', 0x111111))
      tint(gimbalMaterial, themeColour('--color-accent', 0x38bdf8))
      tint(ghostMaterial, themeColour('--color-accent', 0x38bdf8))
      tint(workMaterial, themeColour('--color-success', 0x22c55e))
      for (const type of JOB_TYPES) {
        const colour = themeColour(jobInk(type), themeFallback(type))
        for (const kind of CAGES) tint(buildMaterials.get(cageOf(type, kind))!, colour)
      }

      // The labels key their redraw on this colour, so the next pass repaints every ring.
      built.tones = cssTones(next)
      shapeNametags(built)
    },
  }
  scene.value = built
  status.value = 'watching'

  const draw = () => {
    built.frame = requestAnimationFrame(draw)
    if (!firstPerson.value) {
      settle(built, performance.now())
      placeAgent(built)

      // Before `update`, which is what applies the target to the camera. After it, the frame would
      // be drawn one step behind and the agent would sit slightly off centre the whole way.
      if (follow.value) followAgent(built)
      keepControlsUseful(built)
      glideZoom(built)
      built.controls?.update()
    }
    showHover(built)
    showBuilds(built)
    showGimbal(built)
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
  }
  draw()

  // Not passive, because the page must not scroll under a wheel turned on the viewer. Held on the
  // scene so it comes off with everything else - see `teardown`.
  built.wheeling = { on: element, handle: (event: WheelEvent) => zoomAtPointer(built, event) }
  element.addEventListener('wheel', built.wheeling.handle, { passive: false })

  // The canvas, not the window. Opening or closing the chat rail changes how much room this has
  // without the window changing at all, and a viewer that only listened for the latter kept
  // rendering at its old width until something else happened to trigger it.
  built.watcher = new ResizeObserver(() => resize())
  built.watcher.observe(element)
}

/**
 * Redraws the line whenever the store's copy of the journey changes.
 *
 * Off the store rather than off the world stream, and deliberately: a path is what the planner
 * decided, not something in the world, so it travels on the ordinary live channel and the binary
 * stream stays what it is - blocks and bodies, opaque to everything in between.
 */
watch(
  () => {
    const path = agentStore.pathOf(props.agentId)
    // Depended on by value rather than by reference: the store replaces the map on every update, so
    // watching the object alone would redraw a few hundred segments once a second for a line that
    // has not moved.
    if (!path?.nodes) return null

    // The generated schema leaves every coordinate optional, because springdoc does not mark a
    // non-null Kotlin `Int` as required. One without a position is not a block anybody can draw, so
    // it is dropped here rather than defaulted to the origin.
    const work = (path.work ?? []).flatMap((spot) =>
      spot.x === undefined || spot.y === undefined || spot.z === undefined
        ? []
        : [{ x: spot.x, y: spot.y, z: spot.z }],
    )

    return { nodes: path.nodes, work, progress: path.progress ?? 0 }
  },
  (journey) => {
    const current = scene.value
    if (!current) return

    showPath(current, journey?.nodes ?? [], journey?.progress ?? 0)
    showWork(current, journey?.work ?? [])
  },
  { deep: true },
)

/**
 * Where somebody clicked in the world, until they act on it or click elsewhere.
 *
 * The same bargain the map makes, and it matters more here: this canvas is *orbited*, so almost
 * every press is the start of a drag. A click that sent the agent walking would turn every stopped
 * rotation into an order nobody gave.
 */
const picked = ref<{ x: number; y: number; z: number; px: number; py: number } | null>(null)

/** Where the press began, and whether it turned into an orbit. */
let pressed: { x: number; y: number; moved: boolean } | null = null

/** Whether the drag in progress is the one that carries the pivot. */
let carrying = false

/** When the camera was last moved, so the gimbal can be shown while it is being used. */
let stirred = 0

/** Pixels of travel before a press stops being a click. */
const SLOP = 4

/**
 * Who a click in this world can be about.
 *
 * The whole fleet standing in the same place, not only the agent being watched. A point in this view
 * is a point in a world, and "send these four to that doorway" is the same decision as sending one -
 * which is the argument the map already makes, so it is the same list and the same panel here.
 *
 * Filtered by world as well as by server: the dimensions share a coordinate system, so an agent in
 * the Nether sent to a spot seen in the Overworld would walk to somewhere eight times too far away.
 */
const sendable = computed(() => {
  const watched = agent.value
  if (!auth.can('agent.run') || !watched) return []

  const world = watched.telemetry?.dimension
  const here = agentStore.agents.filter(
    (other) =>
      isOnline(other) &&
      other.serverAddress === watched.serverAddress &&
      (!world || !other.telemetry?.dimension || other.telemetry.dimension === world),
  )

  // The one being watched first. It is what the screen is about, and it is what somebody clicking
  // in its view almost always means.
  return here.some((other) => other.id === watched.id)
    ? [watched, ...here.filter((other) => other.id !== watched.id)]
    : here
})

/**
 * Who the click is for, kept while the panel is open.
 *
 * The watched agent is ticked when the panel opens - unlike the map, which starts from nobody. This
 * screen is *about* one agent, so sending it where you just pointed should be one click; the map is
 * about a fleet and has no such default to draw on.
 */
const sending = ref<number[]>([])
const sendingBusy = ref(false)

/**
 * Whether a drag is the one that carries the pivot.
 *
 * **Two buttons do it, not one.** Upstream pans on the right button *or* on the left with ctrl,
 * meta or shift held - both land in the same handler and do exactly the same thing - and it
 * swaps the other way too, so the right button with a modifier orbits. Everything here that
 * cared about panning asked only whether the right button was down, so the left-with-modifier
 * half of it went unnoticed: the view panned while the pivot mark stayed hidden, and following
 * was never let go of, which meant the pan was overwritten by the next frame putting the target
 * back on the agent. The harder the agent was moving, the more there was to fight.
 */
function pans(event: PointerEvent): boolean {
  if (event.button === TURNING) return event.ctrlKey || event.metaKey || event.shiftKey
  if (event.button === PANNING) return !(event.ctrlKey || event.metaKey || event.shiftKey)

  return false
}

function onPointerDown(event: PointerEvent): void {
  pressed = { x: event.clientX, y: event.clientY, moved: false }
  carrying = pans(event)

  /*
   * **Panning takes the camera off the agent, which means letting go of it.**
   *
   * Following works by putting the orbit target back on the agent every frame. That is what keeps
   * the body in the middle of the screen, and it is also why dragging the view somewhere else did
   * nothing: the pan landed and was overwritten before the next frame drew, so the harder the agent
   * was moving the more there was to fight. Asking to look somewhere else is a clear enough
   * statement that the answer is to stop following rather than to argue with it.
   */
  if (pans(event) && follow.value) follow.value = false

  // Only a pan carries the pivot; an orbit swings around it and leaves it where it is. See
  // {@link showGimbal} for why that decides whether it is drawn.
  if (pans(event)) stirred = performance.now()
}

function onPointerMove(event: PointerEvent): void {
  const current = scene.value
  const box = canvas.value?.getBoundingClientRect()

  // Recorded, not acted on. What is under the cursor is worked out once a frame - see `showHover`.
  if (current && box) {
    current.over = {
      nx: ((event.clientX - box.left) / box.width) * 2 - 1,
      ny: -((event.clientY - box.top) / box.height) * 2 + 1,
    }
  }

  // A pan is the drag that moves the pivot. An orbit turns about it without touching it, so it
  // has nothing to say about where it is.
  if (pressed?.moved && carrying) stirred = performance.now()

  if (!pressed || pressed.moved) return
  if (Math.abs(event.clientX - pressed.x) + Math.abs(event.clientY - pressed.y) > SLOP) pressed.moved = true
}

/** The cursor left the canvas, so there is nothing under it. */
function onPointerLeave(): void {
  const current = scene.value
  if (current) delete current.over
}

function onPointerUp(event: PointerEvent): void {
  const press = pressed
  pressed = null

  const current = scene.value
  const element = canvas.value
  const box = element?.getBoundingClientRect()

  if (!press || press.moved || !current || !box || firstPerson.value) return

  // This press already did its job on the way down.
  if (dismissing) {
    dismissing = false
    return
  }

  const px = event.clientX - box.left
  const py = event.clientY - box.top

  // Normalised device coordinates: the middle of the canvas is the origin and the edges are ±1,
  // with y running up rather than down.
  const at = current.pick?.((px / box.width) * 2 - 1, -(py / box.height) * 2 + 1)
  if (!at) return

  sending.value = agent.value ? [agent.value.id] : []
  picked.value = { ...at, px, py }
}

async function sendThere(): Promise<void> {
  const at = picked.value
  const who = [...sending.value]
  if (!at || who.length === 0) return

  // The middle of the block rather than its corner, which is where a body stands. The corner is
  // shared by four columns and the search would round it to whichever one it liked.
  const to = { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }

  sendingBusy.value = true
  let failed = 0

  // One request each, and the failures counted rather than thrown: a fleet of four where the third
  // host has gone away must still send the other three, and say how many did not go.
  for (const id of who) {
    try {
      await agentStore.sendTo(id, [to])
    } catch {
      failed++
    }
  }

  sendingBusy.value = false
  close()

  if (failed) toasts.notify('error', 'errors.sendTo', { params: { count: failed } })
}

/** The open panel, so a click can be asked whether it landed inside it. See `ActionMenu.root`. */
const menu = ref<InstanceType<typeof ActionMenu> | null>(null)

function close(): void {
  picked.value = null
  sending.value = []
}

/**
 * Whether the press now in flight was the one that put a panel away.
 *
 * **A click in the world does two things at once**, and that is why "click outside to close" looked
 * broken: the panel was dismissed on the way down and a new one opened on the way up, at whatever
 * the pointer happened to be over. The panel had closed - it just never stayed closed long enough to
 * see.
 *
 * So a press either dismisses or picks, never both. The first click puts the panel away and the
 * second one opens a new one, which is what dismissing means everywhere else in the interface.
 *
 * Set on every press that reaches the dismiss handler, which is all of them, so it can never be read
 * stale by a later click.
 */
let dismissing = false

function elsewhere(event: PointerEvent): void {
  dismissing = false

  // Not while a request is in flight: the panel is what is being waited on, and taking it away
  // mid-send would leave an operator watching nothing.
  if (sendingBusy.value) return

  // `composedPath` rather than `contains`, so a click on something the click handler removes is
  // still recognised as having been inside.
  const inside = menu.value?.root
  if (inside && event.composedPath().includes(inside as EventTarget)) return

  dismissing = picked.value !== null
  close()
}

function dismiss(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !sendingBusy.value) close()
}

onMounted(() => {
  document.addEventListener('pointerdown', elsewhere, true)
  document.addEventListener('keydown', dismiss)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', elsewhere, true)
  document.removeEventListener('keydown', dismiss)
})

// There is nothing to point at through the agent's own eyes, and nothing to point at in a world
// that has gone.
watch([firstPerson, () => status.value], () => {
  close()
})

function resize(): void {
  const current = scene.value
  const element = canvas.value
  if (!current || !element) return

  current.viewer.camera.aspect = element.clientWidth / element.clientHeight
  current.viewer.camera.updateProjectionMatrix()
  current.renderer.setSize(element.clientWidth, element.clientHeight, false)
  // The box's width is a number of pixels, which means nothing without knowing how many there are.
  for (const material of [
    ...(current.outlineMaterials ?? []),
    ...(current.pathMaterials ?? []),
    ...(current.markerMaterials ?? []),
  ]) {
    material.resolution.set(element.clientWidth, element.clientHeight)
  }
}

function fail(message: string): void {
  failure.value = message
  status.value = 'failed'
  teardown()
}

/**
 * Closing the socket is what stops the stream at the far end: the backend counts watchers and tells
 * the host to stop following the agent once the last one goes. Leaving this screen has to actually
 * close it, or a host keeps following a world nobody is looking at.
 */
function teardown(): void {
  waiting = []
  building = false

  /*
   * The socket goes first, and separately from the scene, because it can outlive one.
   *
   * A stream is opened before there is anything to draw with - the world it announces is what the
   * scene is built from - so between those two moments there is no scene to hang it off. Closing
   * only `scene.socket` therefore left one open and unreferenced whenever a screen was left, or
   * reconnected, in that window: still subscribed, still handing frames to a handler that would
   * build a second scene beside the one being built now.
   *
   * Its handlers come off before it closes. `onclose` reports a stream that ended as a failure, and
   * one this code closed on purpose is not - left attached, it arrives a moment later and fails the
   * attempt that replaced it.
   */
  if (live) {
    live.onclose = null
    live.onmessage = null
    if (live.readyState <= WebSocket.OPEN) live.close()
    live = undefined
  }

  const current = scene.value
  scene.value = undefined
  if (!current) return

  current.watcher?.disconnect()
  if (current.wheeling) current.wheeling.on.removeEventListener('wheel', current.wheeling.handle)
  // Before the renderer goes, while there is still a scene to take them out of.
  if (current.hover) {
    current.viewer.world.scene.remove(current.hover)
    disposeGeometry(current.hover)
  }
  if (current.gimbal) {
    current.viewer.world.scene.remove(current.gimbal)
    disposeGeometry(current.gimbal)
  }
  if (current.ghost) {
    current.viewer.world.scene.remove(current.ghost)
    disposeGeometry(current.ghost)
  }
  for (const line of current.pathLines ?? []) {
    current.viewer.world.scene.remove(line)
    disposeGeometry(line)
  }
  for (const box of current.workBoxes ?? []) {
    current.viewer.world.scene.remove(box)
    disposeGeometry(box)
  }
  // Every body, the agent's own included, and every column - see `release`.
  for (const body of Object.values(current.viewer.entities?.entities ?? {})) release(body)
  release(current.body)
  for (const mesh of Object.values(current.viewer.world.sectionMeshs ?? {})) mesh?.geometry?.dispose()
  current.heads.clear()

  /*
   * **The workers are what kept all of it alive.** Each holds its own copy of the world and of the
   * block states, and its message handler holds the renderer and everything in its scene - so a worker
   * left running after its screen closed kept a whole world, and a viewer opened ten times held ten.
   */
  for (const worker of current.viewer.world.workers) {
    worker.onmessage = null
    worker.terminate()
  }

  clearTimeout(current.summary)
  cancelAnimationFrame(current.frame)
  current.emitter.removeAllListeners()
  current.controls?.dispose()
  current.renderer.dispose()
  // `dispose` frees what three allocated and keeps the context; the browser holds a context's memory
  // until the page is gone unless it is told to let go.
  current.renderer.forceContextLoss()
  if (current.socket.readyState <= WebSocket.OPEN) current.socket.close()
}

/** Where `scripts/viewer-assets.mjs` stages the renderer's assets. */
const ASSETS = '/viewer'
</script>

<template>
  <div class="bg-base-300 relative min-h-0 flex-1 overflow-hidden">
    <canvas
      ref="canvas"
      class="size-full"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave"
    />

    <!--
      Over the view rather than beside it, and in the corner the map puts its readout in, because
      they are the same kind of thing: a quiet note about the surface it sits on. Hidden in first
      person, where none of it applies - there is no pivot and no orbit, only a head.
    -->
    <div
      v-if="!firstPerson"
      class="bg-base-200/80 pointer-events-none absolute bottom-2 left-2 rounded px-2 py-1 font-mono text-xs shadow-sm"
    >
      <span class="opacity-60">
        {{ t('viewer.legendOrbit') }} · {{ t('viewer.legendPan') }} · {{ t('viewer.legendZoom') }} ·
        {{ t('viewer.legendFast') }} · {{ t('viewer.legendFly') }}
      </span>
    </div>

    <!--
      Anchored where the click landed, over the canvas. The block it names is the one the ray came
      out at, so the panel and the highlight are the same answer said twice.
    -->
    <ActionMenu
      v-if="picked && sendable.length"
      ref="menu"
      placement="at"
      :x="picked.px"
      :y="picked.py"
      :title="t('viewer.sendHere')"
      :note="`${picked.x}, ${picked.y}, ${picked.z}`"
    >
      <!-- The fleet's own picker, exactly as the map opens it: one agent and four are one decision. -->
      <div class="w-64 max-w-[70vw] px-2 py-1.5">
        <AgentTargets v-model="sending" :agents="sendable" />
      </div>

      <!--
        Solid rather than soft, and the panel wide: this is the one thing the panel is for, and it
        acts in the world. Everything else here is a choice about what it will act on.
      -->
      <button
        type="button"
        class="btn btn-primary btn-sm mx-2 mb-2 justify-center gap-2 shadow-sm"
        :disabled="sendingBusy || sending.length === 0"
        @click="sendThere()"
      >
        <span v-if="sendingBusy" class="loading loading-spinner loading-xs"></span>
        <Footprints v-else class="size-4" />
        {{ t('map.sendCount', { count: sending.length }) }}
      </button>
    </ActionMenu>

    <!--
      The world stays on screen when the agent leaves it, because it is the only picture of where it
      was when it went - but it stops being true at that moment, and a still frame is indistinguish-
      able from a live one. Said over the scene rather than replacing it, and it clears itself when
      the agent is back and the stream resumes.
    -->
    <Transition name="fade">
      <p
        v-if="stale"
        role="status"
        class="alert alert-warning alert-soft absolute inset-x-0 top-3 z-10 mx-auto w-fit gap-2 py-2 shadow-md"
      >
        <TriangleAlert class="size-4 shrink-0" />
        {{ t('viewer.outdated') }}
      </p>
    </Transition>

    <div class="absolute top-3 right-3 z-10 flex gap-2">
      <!--
        Only outside first person. There, the camera is the agent's own head and following it is
        what it is already doing, so the toggle would be a switch with one position.
      -->
      <label v-if="!firstPerson" class="btn btn-sm gap-2 shadow-md" :class="follow ? 'btn-primary' : ''">
        <input v-model="follow" type="checkbox" class="hidden" />
        <LocateFixed class="size-4" />
        {{ t('viewer.follow') }}
      </label>
      <label class="btn btn-sm gap-2 shadow-md" :class="firstPerson ? 'btn-primary' : ''">
        <input v-model="firstPerson" type="checkbox" class="hidden" />
        <component :is="firstPerson ? Eye : Orbit" class="size-4" />
        {{ firstPerson ? t('viewer.firstPerson') : t('viewer.orbit') }}
      </label>
    </div>

    <div
      v-if="status !== 'watching'"
      class="bg-base-200/80 absolute inset-0 flex flex-col items-center justify-center gap-3 text-center"
    >
      <span v-if="status === 'connecting'" class="loading loading-spinner loading-lg opacity-40" />
      <p class="text-sm" :class="status === 'failed' ? 'text-error' : 'opacity-60'">
        {{ status === 'failed' ? failure : t('viewer.connecting') }}
      </p>
    </div>
  </div>
</template>
