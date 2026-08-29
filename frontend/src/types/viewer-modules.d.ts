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
    ClampToEdgeWrapping: number
    WebGLRenderer: new (parameters: { canvas: HTMLCanvasElement }) => {
      domElement: HTMLCanvasElement
      setPixelRatio(ratio: number): void
      setSize(width: number, height: number): void
      render(scene: unknown, camera: unknown): void
      dispose(): void
    }
  }
  export = THREE
}

declare module 'three/examples/jsm/controls/OrbitControls.js' {
  export class OrbitControls {
    constructor(camera: unknown, element: HTMLElement)
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
