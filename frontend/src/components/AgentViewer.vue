<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, Orbit, TriangleAlert } from 'lucide-vue-next'

import { api } from '../api/client'
import { isOnline, useAgentStore } from '../stores/agents'
import { Emitter, FrameError, readFrame, type ViewerEvent } from '../lib/viewerStream'
import { gamemodeLabel } from '../lib/vitals'

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
  }
  /** Watches the canvas, not the window - see {@link resize}. */
  watcher?: ResizeObserver
  /** The one material every player's box shares; its width is in pixels, so it tracks the canvas. */
  outlineMaterial?: { resolution: { set(width: number, height: number): void } }
  controls?: { enabled: boolean; update(): void; dispose(): void; target: { set(x: number, y: number, z: number): void } }
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
  /** Where the agent was last seen, so a jump can be told from a walk. See {@link frameCamera}. */
  lastAt?: { x: number; y: number; z: number }
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
  at: Map<number, { x: number; y: number; z: number }>
  /** How big each is, for the box drawn around it. */
  sizes: Map<number, { width: number; height: number }>
  /** Builds an outline in the entity mesh's own units. Held so the decoration needs no imports. */
  buildOutline?: (width: number, height: number) => Mesh | undefined
  summary?: ReturnType<typeof setTimeout>
}

interface Mesh {
  position: { set(x: number, y: number, z: number): void }
  scale: { set(x: number, y: number, z: number): void }
  rotation: { y: number }
  visible: boolean
  frustumCulled: boolean
  renderOrder: number
  userData: Record<string, unknown>
  add(child: unknown): void
  children?: Array<{
    isSprite?: boolean
    frustumCulled: boolean
    renderOrder: number
    scale: { set(x: number, y: number, z: number): void }
    userData: Record<string, unknown>
    material?: SpriteMaterial
  }>
}

interface SpriteMaterial {
  transparent: boolean
  depthWrite: boolean
  needsUpdate: boolean
  depthTest: boolean
  /** False keeps the label one size at every distance. */
  sizeAttenuation: boolean
  map?: {
    image?: HTMLCanvasElement
    generateMipmaps: boolean
    minFilter: number
    magFilter: number
    wrapS: number
    wrapT: number
    needsUpdate: boolean
  }
}

/** One vertex stream of a section mesh. `onUpload` fires once three has handed it to the GPU. */
interface AttributeLike {
  onUpload(callback: (this: { array: unknown }) => void): unknown
}

interface GeometryLike {
  dispose(): void
  computeBoundingSphere(): void
  attributes: Record<string, AttributeLike | undefined>
  index?: AttributeLike | null
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

/** Sets `array` to null. Called by three with the attribute as `this`. */
function shed(this: { array: unknown }): void {
  this.array = null
}

/**
 * Lets a finished section mesh drop its vertex data once the GPU has it.
 *
 * `BufferAttribute` keeps the `Float32Array` it was built from alive for as long as the mesh is in
 * the scene, so every section is held twice over - once in the GPU buffer that draws it and once in
 * a copy on the JS heap that nothing reads. It is not nothing: the renderer does no greedy meshing,
 * so a section is four vertices of eleven floats for every visible face, and there are 24 of them
 * per column across 144 columns.
 *
 * The copy is only worth keeping for something that reads vertices back - raycasting, or recomputing
 * bounds. Neither happens here: `Viewer.listen` raycasts nothing (its pointer handler emits the ray
 * rather than intersecting with it), and the bounds are computed here, while the data still exists,
 * because frustum culling needs them on the first frame.
 */
function releaseGeometry(mesh: { geometry?: GeometryLike } | undefined): void {
  const geometry = mesh?.geometry
  if (!geometry) return

  geometry.computeBoundingSphere()
  for (const attribute of Object.values(geometry.attributes)) attribute?.onUpload(shed)
  geometry.index?.onUpload(shed)
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
  for (const [id, mesh] of Object.entries(current.viewer.entities?.entities ?? {})) {
    if (!mesh) continue

    // These meshes are built with their geometry in absolute model coordinates while their bones
    // carry accumulated pivots, so the bounding sphere three computes for them does not describe
    // where they actually are - and an entity disappears at the angles where that wrong sphere
    // leaves the frustum. There are a few dozen of them; not culling them costs nothing.
    mesh.frustumCulled = false

    // A box around each player, drawn through everything. Only players: an operator watching an
    // agent is watching for people, and outlining every cow would bury them.
    if (current.seen.get(Number(id)) === 'player' && !mesh.userData['osmiumOutlined']) {
      const size = current.sizes.get(Number(id))
      const outline = size && current.buildOutline?.(size.width, size.height)
      if (outline) {
        mesh.userData['osmiumOutlined'] = true
        mesh.add(outline)
      }
    }

    for (const child of mesh.children ?? []) {
      if (!child.isSprite || child.userData['osmiumOutline']) continue
      child.frustumCulled = false
      if (child.userData['osmiumShaped']) continue
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
      if (!material) continue
      material.transparent = true
      material.depthWrite = false
      // One size, whatever the distance. A sprite shrinks with range by default, which is right for
      // a thing in the world and wrong for a label about one: the name furthest away is the hardest
      // to read and often the one worth reading.
      material.sizeAttenuation = false
      // Over the world, as Minecraft draws them: depth-tested, a tag is occluded by the very head
      // it labels at every angle where that head is nearer the camera.
      material.depthTest = false

      const map = material.map
      if (!map) continue
      // Clamped and unmipped: what a non-power-of-two texture needs, and what stops the sampler
      // reaching past the edge of the drawn name.
      map.generateMipmaps = false
      map.minFilter = current.filters.linear
      map.magFilter = current.filters.linear
      map.wrapS = current.filters.clamp
      map.wrapT = current.filters.clamp

      material.needsUpdate = true
    }

    // Outside the once-only block: the distance changes as the agent and the player move, so the
    // label is redrawn when the number it shows would differ - not every frame, and not never.
    for (const child of mesh.children ?? []) {
      if (!child.isSprite || child.userData['osmiumOutline']) continue
      const map = child.material?.map
      if (!map?.image) continue

      const name = current.names.get(Number(id))
      const away = distanceTo(current, Number(id))
      const stats = statsFor(name)

      const label = `${away ?? ''}|${stats ?? ''}`
      if (child.userData['osmiumLabel'] === label) continue
      child.userData['osmiumLabel'] = label

      redrawNametag(map.image, name, away, stats)
      map.needsUpdate = true
    }
  }
}

/**
 * How far the agent is from an entity, in whole blocks. Null when either position is unknown.
 *
 * Distance rather than health, because health is not ours to show: a client is only told its own,
 * and everyone else's lives in raw entity metadata at an index that moves between versions.
 * mineflayer does not decode it, and guessing at a byte offset per protocol would produce a number
 * that is wrong without ever looking wrong.
 */
function distanceTo(current: Scene, id: number): number | null {
  const from = current.position?.pos
  const to = current.at.get(id)
  if (!from || !to) return null
  return Math.round(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z))
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
function statsFor(name: string | undefined): string | null {
  if (!name) return null

  const player = nearby.value.find((candidate) => candidate.name === name)
  if (!player) return null

  const parts: string[] = []
  if (player.ping !== null && player.ping !== undefined) parts.push(`${player.ping}ms`)
  const mode = gamemodeLabel(player.gamemode)
  if (mode) parts.push(mode)
  if (player.isAgent) parts.push(t('viewer.ours'))

  return parts.length ? parts.join(' · ') : null
}

/** The protocol's own numbering. Survival is the default and says nothing, so it is left unnamed. */
function redrawNametag(
  canvas: HTMLCanvasElement | undefined,
  name: string | undefined,
  away: number | null,
  stats: string | null,
): void {
  if (!canvas || !name) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'

  // White on a dark outline rather than plain black: a label has to stay readable over stone,
  // grass, lava and the sky, and no single fill colour does that.
  const write = (text: string, y: number, size: number, colour: string) => {
    ctx.font = `${Math.floor(size)}px sans-serif`
    ctx.lineWidth = Math.max(2, size * 0.16)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
    ctx.strokeText(text, canvas.width / 2, y)
    ctx.fillStyle = colour
    ctx.fillText(text, canvas.width / 2, y)
  }

  // The name identifies; the distance is what an operator is actually watching for, so it is there
  // but subordinate.
  const below = [away === null ? null : `${away}m`, stats].filter(Boolean).join('  ·  ')
  if (!below) {
    write(name, canvas.height / 2, canvas.height * 0.62, '#ffffff')
    return
  }

  write(name, canvas.height * 0.34, canvas.height * 0.48, '#ffffff')
  write(below, canvas.height * 0.78, canvas.height * 0.3, '#d4d4d8')
}

/** Past anything the world puts in the transparent pass, so a name is never sorted behind a body. */
const NAMETAG_ORDER = 1000

/**
 * The box takes the interface's own accent, so a viewer looks like the rest of Osmium and follows a
 * change of theme without a second place to edit.
 *
 * Resolved through a canvas rather than parsed: the token is authored in oklch, which three's colour
 * parser does not read, and a one-pixel fill is the browser's own converter. Falls back to the
 * accent's default if the token is missing or in some notation the canvas also refuses.
 */
function themeColour(): number {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()
  if (!token) return OUTLINE_FALLBACK

  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const ctx = probe.getContext('2d')
  if (!ctx) return OUTLINE_FALLBACK

  // An unreadable value leaves fillStyle untouched, so a sentinel says whether it was understood.
  ctx.fillStyle = '#000000'
  ctx.fillStyle = token
  if (ctx.fillStyle === '#000000') return OUTLINE_FALLBACK

  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0)
}

const OUTLINE_FALLBACK = 0x4ade80

/** How thick the box is drawn, in pixels. */
const OUTLINE_WIDTH = 3

/** What upstream draws a name onto. */
const NAMETAG_CANVAS = { width: 500, height: 100 }

/**
 * How wide the label is on screen, as world units at unit distance.
 *
 * Not blocks: with size attenuation off, three cancels the perspective divide, so this number is
 * read against the frustum rather than against the world. At a 75 degree field of view it works out
 * near a sixth of the viewport's width, whatever the distance.
 */
const NAMETAG_WIDTH = 0.28

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
    if (entity.name) current.seen.set(entity.id, entity.name)
    if (entity.username) current.names.set(entity.id, entity.username)
    if (entity.pos) current.at.set(entity.id, entity.pos)
    if (entity.width !== undefined && entity.height !== undefined) {
      current.sizes.set(entity.id, { width: entity.width, height: entity.height })
    }
    if (entity.delete) {
      current.at.delete(entity.id)
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
  current.undrawable.clear()
  current.seen.clear()
  current.names.clear()
  current.at.clear()
  current.sizes.clear()
  current.received = 0

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

function showAgent(current: Scene): void {
  const { pos, yaw } = current.position ?? {}
  if (!pos || yaw === undefined) return

  if (!current.body) {
    const built = current.buildBody?.()
    if (!built) return
    current.body = built
    built.visible = !firstPerson.value
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
  const { LineSegments2 } = await import('three/examples/jsm/lines/LineSegments2.js')
  const { LineSegmentsGeometry } = await import('three/examples/jsm/lines/LineSegmentsGeometry.js')
  const { LineMaterial } = await import('three/examples/jsm/lines/LineMaterial.js')

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
  renderer.setSize(element.clientWidth, element.clientHeight, false)

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
      if (event.data.type === 'geometry') releaseGeometry(viewer.world.sectionMeshs?.[event.data.key ?? ''])
    }
  }

  viewer.world.texturesDataUrl = `${ASSETS}/textures/${version}.png`
  const states = await fetch(`${ASSETS}/blocksStates/${version}.json`)
  if (!states.ok) return fail(t('viewer.unstaged', { version }))
  viewer.world.blockStatesData = await states.json()

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

  // Shared by every box: the width is measured in pixels, so the material has to be told the size
  // of the canvas - and one material means one thing to keep in step with it. See `resize`.
  const outlineMaterial = new LineMaterial({
    color: themeColour(),
    linewidth: OUTLINE_WIDTH,
    depthTest: false,
    transparent: true,
  })
  outlineMaterial.resolution.set(element.clientWidth, element.clientHeight)

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
    // In world units, not model units: what an entity is attached to is a plain Object3D, and the
    // sixteenth-scale lives on its children. Scaling for it here made everything sixteen times its
    // size.
    buildOutline: (width: number, height: number) => {
      const box = new THREE.BoxGeometry(width, height, width)
      // The model stands on its origin, so the box is raised to sit around it rather than straddle.
      box.translate(0, height / 2, 0)

      // `LineSegments2` rather than `LineSegments`: `linewidth` is inert on a plain line material -
      // WebGL draws every line one pixel wide whatever it says - and this one builds the segments
      // out of quads instead, so a width is actually a width.
      const outline = new LineSegments2(
        new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(box)),
        outlineMaterial,
      ) as unknown as Mesh
      outline.renderOrder = NAMETAG_ORDER
      outline.frustumCulled = false
      // Named so the pass that owns nametags leaves it alone.
      outline.userData['osmiumOutline'] = true
      return outline
    },
    filters: { linear: THREE.LinearFilter, clamp: THREE.ClampToEdgeWrapping },
    bounds,
    received: 0,
    outlineMaterial,
    seen: new Map(),
    names: new Map(),
    at: new Map(),
    sizes: new Map(),
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

  // The canvas, not the window. Opening or closing the chat rail changes how much room this has
  // without the window changing at all, and a viewer that only listened for the latter kept
  // rendering at its old width until something else happened to trigger it.
  built.watcher = new ResizeObserver(() => resize())
  built.watcher.observe(element)
}

function resize(): void {
  const current = scene.value
  const element = canvas.value
  if (!current || !element) return

  current.viewer.camera.aspect = element.clientWidth / element.clientHeight
  current.viewer.camera.updateProjectionMatrix()
  current.renderer.setSize(element.clientWidth, element.clientHeight, false)
  // The box's width is a number of pixels, which means nothing without knowing how many there are.
  current.outlineMaterial?.resolution.set(element.clientWidth, element.clientHeight)
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

  const current = scene.value
  scene.value = undefined
  if (!current) return

  current.watcher?.disconnect()
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
  <div class="bg-base-300 relative min-h-0 flex-1 overflow-hidden">
    <canvas ref="canvas" class="size-full" />

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

    <div class="absolute top-3 right-3 z-10">
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
