/**
 * The renderer's packages, which ship no types.
 *
 * three 0.128 predates its bundled declarations, and prismarine-viewer has never had any. Declared
 * here rather than pulling in `@types/three` for a version that old: only `AgentViewer.vue` touches
 * either of them, and it models the handful of members it uses itself - a full set of declarations
 * for a renderer this app does not otherwise talk to would be more surface to keep true than the
 * component it serves.
 */
declare module 'three' {
  const THREE: {
    DefaultLoadingManager: { setURLModifier(modifier: (url: string) => string): void }
    LinearFilter: number
    /** What a Minecraft texture is sampled with: anything else smears a 64-pixel sheet. */
    NearestFilter: number
    RepeatWrapping: number
    /** A skin arrives as a canvas, because a legacy one has to be redrawn before it can be used. */
    CanvasTexture: new (image: HTMLCanvasElement) => {
      image?: HTMLCanvasElement
      generateMipmaps: boolean
      minFilter: number
      magFilter: number
      wrapS: number
      wrapT: number
      flipY: boolean
      needsUpdate: boolean
    }
    /** A nametag: a canvas quad that keeps facing the camera. Upstream builds one per player. */
    Sprite: new (material: unknown) => {
      position: { set(x: number, y: number, z: number): void }
      userData: Record<string, unknown>
      isSprite: boolean
    }
    SpriteMaterial: new (parameters: { map: unknown }) => unknown
    /** One dot per path node. A geometry of bare positions is all a point cloud needs. */
    BufferGeometry: new () => {
      setAttribute(name: string, attribute: unknown): void
      dispose(): void
    }
    Float32BufferAttribute: new (array: number[], itemSize: number) => unknown
    Points: new (geometry: unknown, material: unknown) => unknown
    PointsMaterial: new (parameters: {
      color?: number
      size?: number
      /** Off, so a node is the same size wherever it is on the route. */
      sizeAttenuation?: boolean
      depthTest?: boolean
      transparent?: boolean
      opacity?: number
    }) => { dispose(): void }
    BoxGeometry: new (width: number, height: number, depth: number) => { translate(x: number, y: number, z: number): void }
    EdgesGeometry: new (geometry: unknown) => unknown
    ClampToEdgeWrapping: number
    /** Asks what is under the cursor. Only ever pointed at the world's own section meshes. */
    Raycaster: new () => {
      setFromCamera(coords: { x: number; y: number }, camera: unknown): void
      intersectObjects(objects: unknown[], recursive?: boolean): unknown[]
    }
    WebGLRenderer: new (parameters: { canvas: HTMLCanvasElement }) => {
      domElement: HTMLCanvasElement
      setPixelRatio(ratio: number): void
      /** `updateStyle: false` leaves the CSS size alone, for a canvas sized by the page. */
      setSize(width: number, height: number, updateStyle?: boolean): void
      render(scene: unknown, camera: unknown): void
      dispose(): void
    }
  }
  export = THREE
}

declare module 'three/examples/jsm/controls/OrbitControls.js' {
  export class OrbitControls {
    constructor(camera: unknown, element: HTMLElement)
    enabled: boolean
    target: { set(x: number, y: number, z: number): void }
    update(): void
    dispose(): void
  }
}

declare module 'prismarine-viewer/viewer' {
  export class Viewer {
    constructor(renderer: unknown)
  }

  /** One rendered figure. The version is upstream's fixed one for entities, not the server's. */
  export class Entity {
    constructor(version: string, type: string, scene: unknown)
    mesh: unknown
  }

  /**
   * Mutable, and mutated on purpose: `getVersion` returns an exact match before it consults its
   * table of majors, so appending a version is enough to have that version accepted.
   */
  export const supportedVersions: string[]
}

/** three's thick-line helpers, which its own examples ship untyped. */
declare module 'three/examples/jsm/lines/LineSegments2.js' {
  export class LineSegments2 {
    constructor(geometry: unknown, material: unknown)
  }
}

declare module 'three/examples/jsm/lines/LineSegmentsGeometry.js' {
  export class LineSegmentsGeometry {
    fromEdgesGeometry(geometry: unknown): LineSegmentsGeometry
    /** Segment endpoints, flat: x1 y1 z1 x2 y2 z2, six numbers per segment. */
    setPositions(points: number[]): LineSegmentsGeometry
  }
}

declare module 'three/examples/jsm/lines/LineMaterial.js' {
  export class LineMaterial {
    constructor(parameters: {
      color: number
      linewidth: number
      depthTest: boolean
      transparent: boolean
      /** Only read while `transparent`, which is the only way any of these are built. */
      opacity?: number
    })
    resolution: { set(width: number, height: number): void }
  }
}
