<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, Orbit } from 'lucide-vue-next'

import { api } from '../api/client'
import { Emitter, FrameError, readFrame, type ViewerEvent } from '../lib/viewerStream'

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

const canvas = ref<HTMLCanvasElement>()
/** Free orbit, or looking through the agent's own eyes. Purely a camera choice: both read the same
 * stream, and neither sends anything to the agent. */
const firstPerson = ref(false)
const status = ref<'connecting' | 'watching' | 'failed'>('connecting')
const failure = ref('')

/** Held outside Vue's reactivity: three.js objects are large, cyclic graphs and proxying them is
 * both pointless and slow. */
const scene = shallowRef<Scene>()

interface Scene {
  viewer: ViewerLike
  emitter: Emitter
  socket: WebSocket
  renderer: { setSize(w: number, h: number): void; render(s: unknown, c: unknown): void; dispose(): void }
  controls?: { update(): void; dispose(): void; target: { set(x: number, y: number, z: number): void } }
  frame: number
  position?: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number }
  /** Entity types the renderer can build a mesh for - see {@link buildableModels}. */
  models: Set<string>
  /** Entities ruled out at spawn, so their movements can be dropped too. */
  undrawable: Set<number>
  /** The agent's own body, which nothing in the stream describes - see {@link showAgent}. */
  body?: Mesh
  /** Makes one, from the renderer's player model. Held so `showAgent` needs no imports. */
  buildBody?: () => Mesh | undefined
  /** three's texture constants, carried here so the nametag fix-up needs no import. */
  filters: { linear: number; clamp: number }
  /** How many columns the host has sent, for {@link reportCoverage}. */
  received: number
  summary?: ReturnType<typeof setTimeout>
}

interface Mesh {
  position: { set(x: number, y: number, z: number): void }
  rotation: { y: number }
  children?: Array<{
    isSprite?: boolean
    scale: { set(x: number, y: number, z: number): void }
    userData: Record<string, unknown>
    material?: SpriteMaterial
  }>
}

interface SpriteMaterial {
  transparent: boolean
  depthWrite: boolean
  needsUpdate: boolean
  map?: {
    generateMipmaps: boolean
    minFilter: number
    magFilter: number
    wrapS: number
    wrapT: number
    needsUpdate: boolean
  }
}

interface WorldLike {
  texturesDataUrl?: string
  blockStatesData?: unknown
  scene: { remove(object: unknown): void }
  sectionMeshs?: Record<string, { geometry?: { dispose(): void } } | undefined>
  loadedChunks?: Record<string, boolean>
  addColumn(x: number, z: number, chunk: unknown): void
  removeColumn(x: number, z: number): void
  setSectionDirty(pos: { x: number; y: number; z: number }, value?: boolean): void
}

interface ViewerLike {
  camera: { position: { set(x: number, y: number, z: number): void }; aspect: number; updateProjectionMatrix(): void }
  scene: { add(object: unknown): void }
  world: WorldLike
  entities?: { entities?: Record<string, Mesh | undefined> }
  setVersion(version: string): boolean
  listen(emitter: Emitter): void
  setFirstPersonCamera(pos: unknown, yaw: number, pitch: number): void
  update(): void
}

onMounted(() => void connect())
onBeforeUnmount(teardown)

watch(firstPerson, (on) => {
  const current = scene.value
  if (!current) return

  if (on) return
  // Coming back out of first person, the orbit camera is wherever the agent's head left it, which
  // is inside its own skull. Pulled back to where the free camera started.
  const at = current.position?.pos
  if (!at) return
  current.controls?.target.set(at.x, at.y, at.z)
  current.viewer.camera.position.set(at.x, at.y + 20, at.z + 20)
})

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

  socket.onmessage = (message) => void receive(message.data as ArrayBuffer, socket)

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

    // `info`, not `debug`: the browser hides debug behind a verbosity setting that is off by
    // default, so a line nobody sees is a line that does not exist.
    console.info(
      `[osmium] viewer @ ${home.x},${home.z}: host sent ${current.received} columns, ` +
        `renderer holds ${columns.length}, ${columns.length - undrawn.length} have geometry. ` +
        `${undrawn.length} blank, ${near.length} of them within 2 columns of the agent` +
        (undrawn.length ? ` — nearest blank: ${undrawn.slice(0, 8).map((c) => `${c}(${away(c)})`).join(' ')}` : ''),
    )
  }, SETTLED)
}

/** How long without a column before the world is considered done arriving. */
const SETTLED = 2_000

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
function extendMeshedHeight(world: WorldLike, minY: number, maxY: number): void {
  const outside = (): number[] => {
    const levels: number[] = []
    const from = Math.floor(minY / SECTION) * SECTION
    for (let y = from; y < maxY; y += SECTION) {
      if (y < UPSTREAM_MIN_Y || y >= UPSTREAM_MAX_Y) levels.push(y)
    }
    return levels
  }

  const added = world.addColumn.bind(world)
  world.addColumn = (x: number, z: number, chunk: unknown) => {
    added(x, z, chunk)
    for (const y of outside()) {
      for (const [dx, dz] of NEIGHBOURS) world.setSectionDirty({ x: x + dx, y, z: z + dz })
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
function drawable(current: Scene, entity: { id: number; name?: string }): boolean {
  if (current.undrawable.has(entity.id)) return false

  if (entity.name !== undefined) {
    if (current.models.has(entity.name)) return true
    current.undrawable.add(entity.id)
    return false
  }

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
 * Makes a nametag legible. Upstream creates the sprite; this corrects it, once, as each appears.
 *
 * Three things are wrong with it as built. It is drawn onto a 500x100 canvas and mapped onto a
 * `THREE.Sprite`, which is a one-by-one quad unless told otherwise, so the name arrives squashed to
 * a fifth of its width. That canvas is not a power of two, and the texture is left on the default
 * mipmapping and repeat wrapping, so everything past the text samples outside the image and comes
 * back as streaked noise. And the material is not marked transparent, so the empty area around the
 * name is composited rather than dropped.
 */
function shapeNametags(current: Scene): void {
  for (const mesh of Object.values(current.viewer.entities?.entities ?? {})) {
    for (const child of mesh?.children ?? []) {
      if (!child.isSprite || child.userData['osmiumShaped']) continue
      child.userData['osmiumShaped'] = true

      child.scale.set(NAMETAG_WIDTH, NAMETAG_WIDTH * (NAMETAG_CANVAS.height / NAMETAG_CANVAS.width), 1)

      const material = child.material
      if (!material) continue
      material.transparent = true
      material.depthWrite = false

      const map = material.map
      if (!map) continue
      // Clamped and unmipped: the combination a non-power-of-two texture needs, and the one that
      // stops the sampler reaching past the edge of the drawn name.
      map.generateMipmaps = false
      map.minFilter = current.filters.linear
      map.magFilter = current.filters.linear
      map.wrapS = current.filters.clamp
      map.wrapT = current.filters.clamp
      map.needsUpdate = true
      material.needsUpdate = true
    }
  }
}

/** What upstream draws a name onto, and how wide to hang it in the world. */
const NAMETAG_CANVAS = { width: 500, height: 100 }
const NAMETAG_WIDTH = 2.5

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

/** Hands one update to the renderer. */
function apply(current: Scene, event: ViewerEvent): void {
  if (event.name === 'position') current.position = event.data as Scene['position']
  if (event.name === 'entity' && !drawable(current, event.data as { id: number; name?: string })) return

  current.emitter.emit(event.name, event.data)
  if (event.name === 'entity') shapeNametags(current)
  if (event.name === 'loadChunk') {
    current.received++
    reportCoverage(current)
  }
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

  for (const event of batch.events) {
    // The host states the version before anything that depends on it, so this is where the scene is
    // built - and rebuilt, if the agent rejoined on a different one.
    if (event.name === 'version') {
      const world = event.data as { version: string; minY?: number; height?: number }
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
function showAgent(current: Scene): void {
  const { pos, yaw } = current.position ?? {}
  if (!pos || yaw === undefined) return

  if (!current.body) {
    const built = current.buildBody?.()
    if (!built) return
    current.body = built
    current.viewer.scene.add(built)
  }

  current.body.position.set(pos.x, pos.y, pos.z)
  current.body.rotation.y = yaw
}

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

  // `viewer/lib/entity/Entity.js` reads a global `THREE` rather than importing one, so without this
  // every entity throws on construction and nothing with a body is ever drawn. Upstream's own
  // client sets exactly this before it builds a viewer.
  ;(globalThis as { THREE?: unknown }).THREE ??= THREE

  if (!supportedVersions.includes(version)) supportedVersions.push(version)

  THREE.DefaultLoadingManager.setURLModifier((url: string) =>
    url.startsWith('textures/') || url.startsWith('blocksStates/') ? `${ASSETS}/${url}` : url,
  )

  const element = canvas.value
  if (!element) return

  const renderer = new THREE.WebGLRenderer({ canvas: element })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(element.clientWidth, element.clientHeight)

  const native = window.Worker
  window.Worker = class extends native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url === 'worker.js' ? `${ASSETS}/worker.js` : url, options)
    }
  }
  let viewer: ViewerLike
  try {
    viewer = new Viewer(renderer) as ViewerLike
  } finally {
    window.Worker = native
  }

  viewer.world.texturesDataUrl = `${ASSETS}/textures/${version}.png`
  const states = await fetch(`${ASSETS}/blocksStates/${version}.json`)
  if (!states.ok) return fail(t('viewer.unstaged', { version }))
  viewer.world.blockStatesData = await states.json()

  if (!viewer.setVersion(version)) return fail(t('viewer.unstaged', { version }))

  // Before anything is listened for, so the very first column is meshed over its whole height.
  // Defaults are the pre-1.18 range, which is what a server that does not state its bounds is.
  extendMeshedHeight(viewer.world, world.minY ?? 0, (world.minY ?? 0) + (world.height ?? 256))

  const emitter = new Emitter()
  viewer.listen(emitter)

  // Upstream reaches for the global `THREE.OrbitControls` its own bundle attaches; the module is
  // the same class, imported the way the rest of this app imports anything.
  const controls = new OrbitControls(viewer.camera as never, element)

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
    filters: { linear: THREE.LinearFilter, clamp: THREE.ClampToEdgeWrapping },
    received: 0,
  }
  scene.value = built
  status.value = 'watching'

  const draw = () => {
    built.frame = requestAnimationFrame(draw)
    if (!firstPerson.value) built.controls?.update()
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
  }
  draw()

  window.addEventListener('resize', resize)
}

function resize(): void {
  const current = scene.value
  const element = canvas.value
  if (!current || !element) return

  current.viewer.camera.aspect = element.clientWidth / element.clientHeight
  current.viewer.camera.updateProjectionMatrix()
  current.renderer.setSize(element.clientWidth, element.clientHeight)
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

  window.removeEventListener('resize', resize)

  const current = scene.value
  scene.value = undefined
  if (!current) return

  clearTimeout(current.summary)
  cancelAnimationFrame(current.frame)
  current.emitter.removeAllListeners()
  current.controls?.dispose()
  current.renderer.dispose()
  if (current.socket.readyState <= WebSocket.OPEN) current.socket.close()
}

/** Where `scripts/viewer-assets.mjs` stages the renderer's assets. */
const ASSETS = '/viewer'
</script>

<template>
  <div class="relative min-h-0 flex-1 overflow-hidden rounded-box">
    <canvas ref="canvas" class="size-full" />

    <div class="absolute top-3 right-3">
      <label class="btn btn-sm gap-2" :class="firstPerson ? 'btn-primary' : ''">
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
