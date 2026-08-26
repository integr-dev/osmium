<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Bot as Agent, Crosshair, Server, Share2 } from 'lucide-vue-next'
import { fleetGraph, type GraphLink, type GraphNode, type LinkHealth } from '../lib/fleetGraph'
import { prefersReducedMotion } from '../lib/motion'
import { fit, IDENTITY, panBy, zoomAt, type View } from '../lib/panZoom'
import { useAgentStore } from '../stores/agents'

/**
 * The deployment as a picture: Osmium, the hosts dialled into it, the agents each host runs.
 *
 * **SVG rather than canvas**, unlike the voxel viewer. There are tens of nodes here, not tens of
 * thousands, and every one of them wants to be a link, carry a tooltip and be reachable by keyboard
 * — all of which the DOM gives for free and a canvas would have to reimplement badly.
 *
 * The geometry lives in `fleetGraph.ts` and is specced. What is left here is paint.
 */
const { t } = useI18n()
const router = useRouter()
const agentStore = useAgentStore()

/**
 * Nothing here is measured against a clock, so there is none.
 *
 * An earlier version ticked one to fade hosts whose heartbeat was going stale, which turned out to
 * be unknowable from the browser — see `hostHealth`. Every state this draws now arrives as an
 * event, including a host going unreachable, so the graph redraws when something has actually
 * happened rather than on a timer.
 */
const graph = computed(() => fleetGraph(agentStore.hosts, agentStore.agents))

/**
 * The picture is moved rather than fitted, because no single fit is right: a fleet of four drawn
 * across a whole panel reads as a fault, and a fleet of forty shrunk into one is unreadable.
 * Wheel to zoom, drag to pan, double-click to put it back — the arithmetic is in `lib/panZoom.ts`.
 */
const box = ref<HTMLElement | null>(null)
const view = ref<View>(IDENTITY)
const dragging = ref(false)

/** Once it has been moved by hand, nothing re-fits it underneath the operator. */
const touched = ref(false)

let from = { x: 0, y: 0 }

function reset() {
  const rect = box.value?.getBoundingClientRect()
  if (!rect) return

  view.value = fit(graph.value.width, graph.value.height, rect.width, rect.height)
  touched.value = false
}

/**
 * Exponential in the wheel's own units, so one notch is the same proportion of the picture at
 * every scale. A linear step zooms in slowly and out catastrophically.
 */
function onWheel(event: WheelEvent) {
  const rect = box.value?.getBoundingClientRect()
  if (!rect) return

  view.value = zoomAt(
    view.value,
    event.clientX - rect.left,
    event.clientY - rect.top,
    Math.exp(-event.deltaY * 0.0015),
  )
  touched.value = true
}

/**
 * Not on a node. Every host and agent in the picture is a link to its own page, and a drag that
 * started on one would either navigate on release or swallow the click that was meant to.
 */
function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  if ((event.target as Element | null)?.closest("a")) return

  event.preventDefault()
  dragging.value = true
  from = { x: event.clientX, y: event.clientY }

  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
}

// On the window rather than the panel: a pointer that leaves the box mid-drag is still dragging.
function onPointerMove(event: PointerEvent) {
  view.value = panBy(view.value, event.clientX - from.x, event.clientY - from.y)
  from = { x: event.clientX, y: event.clientY }
  touched.value = true
}

function onPointerUp() {
  dragging.value = false
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", onPointerUp)
}

onBeforeUnmount(onPointerUp)

// Fitted once the panel has a size, and again when the fleet changes shape — until it is moved.
let observer: ResizeObserver | null = null

onMounted(() => {
  reset()
  observer = new ResizeObserver(() => {
    if (!touched.value) reset()
  })
  if (box.value) observer.observe(box.value)
})

onBeforeUnmount(() => observer?.disconnect())

watch(
  () => `${graph.value.width}x${graph.value.height}`,
  () => {
    if (!touched.value) reset()
  },
)


const still = prefersReducedMotion()

/**
 * Colour carries the health, and so does motion — which is the point rather than redundancy.
 * Colour alone fails anyone who cannot separate the hues, and across a graph the eye catches
 * movement long before it reads a legend.
 */
const STROKE: Record<LinkHealth, string> = {
  live: 'stroke-success/60',
  stale: 'stroke-warning/60',
  down: 'stroke-base-content/15',
}

const FILL: Record<LinkHealth, string> = {
  live: 'fill-success',
  stale: 'fill-warning',
  down: 'fill-base-content/20',
}

const RING: Record<LinkHealth, string> = {
  live: 'stroke-success',
  stale: 'stroke-warning',
  down: 'stroke-base-content/25',
}

/** Seconds for one packet to cross. Faltering links crawl, so slowness reads as trouble. */
const SPEED: Record<LinkHealth, number> = { live: 2.4, stale: 6, down: 0 }

/**
 * A gentle curve rather than a straight line.
 *
 * Two hosts at nearly the same height would otherwise lay their edges on top of each other, and a
 * bundle of straight lines from one point reads as a single thick line rather than as several.
 */
/**
 * A flat S between the two points, bowing out of one horizontally and into the other the same way.
 *
 * The control points sit on the midline, so a link leaving Osmium and a link arriving at an agent
 * meet their nodes level — which is what makes a fan of them read as one bundle rather than as a
 * sheaf of straight lines converging at an angle. It mirrors for free: the midpoint is between the
 * two ends whichever side of Osmium they are on.
 */
function curve(link: GraphLink): string {
  const midX = (link.from.x + link.to.x) / 2
  return `M ${link.from.x} ${link.from.y} C ${midX} ${link.from.y}, ${midX} ${link.to.y}, ${link.to.x} ${link.to.y}`
}

/**
 * Evenly spaced along the edge, so a link reads as a stream rather than a burst.
 *
 * **Negative, which is what keeps them off the corner.** A positive delay leaves the circle sitting
 * at its own coordinates until its turn comes, and a circle with no coordinates sits at the origin
 * of the drawing — a green dot parked in the top-left until the first second had passed. Started in
 * the past instead, every packet is already somewhere along its path on the first frame.
 *
 * Measured against the duration of the link it rides, or a faltering edge would space its one
 * packet against a speed it is not travelling at.
 */
function offsets(link: GraphLink): number[] {
  return Array.from(
    { length: link.packets },
    (_, index) => -(index / link.packets) * SPEED[link.health],
  )
}

/**
 * Where a node goes. `RouterLink` is not used because an anchor it renders inside an `<svg>` lands
 * in the wrong namespace; a real SVG `<a>` with a real href is the thing that works.
 *
 * Which leaves the href doing a full page load on a plain click, so that one case is intercepted
 * and handed to the router. Modified clicks are left alone, because the href is genuine and
 * open-in-new-tab should keep working.
 */
/** Which half of the picture a node is in, and therefore which way its label reads. */
function mirrored(node: GraphNode): boolean {
  const middle = graph.value.nodes.find((entry) => entry.kind === 'osmium')?.at.x ?? 0
  return node.at.x < middle
}

function href(node: GraphNode): string | undefined {
  if (node.kind === 'host') return `/hosts/${node.ref}`
  if (node.kind === 'agent') return `/agents/${node.ref}`
  return undefined
}

function open(event: MouseEvent, node: GraphNode) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  const to = href(node)
  if (!to) return

  event.preventDefault()
  void router.push(to)
}

const legend: Array<{ health: LinkHealth; label: string }> = [
  { health: 'live', label: 'graph.live' },
  { health: 'stale', label: 'graph.stale' },
  { health: 'down', label: 'graph.down' },
]
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm opacity-60">
        {{ t('graph.hint') }}
        <span class="opacity-70">{{ t('graph.hintMove') }}</span>
      </p>
      <div class="flex items-center gap-4">
<span v-for="entry in legend" :key="entry.health" class="flex items-center gap-1.5 text-xs opacity-70">
          <span
            class="size-2 rounded-full"
            :class="{
              'bg-success': entry.health === 'live',
              'bg-warning': entry.health === 'stale',
              'bg-base-content/25': entry.health === 'down',
            }"
          ></span>
          {{ t(entry.label) }}
        </span>
      </div>
    </div>

    <!--
      A viewport, not a fitted picture. Wheel zooms about the pointer, dragging the background
      moves it, double-click puts it back — and none of it touches the diagram, which is drawn once
      at its own size and then transformed.
    -->
    <div
      ref="box"
      class="card border-base-300 bg-base-200 relative min-h-0 flex-1 touch-none overflow-hidden border"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @dblclick="reset"
    >
      <!--
        Over the picture rather than in the row above it. Appearing and disappearing up there
        moved the legend beside it every time the graph was touched or fitted; here it is out of
        the flow, so it costs no room whether it is shown or not — and it is a control on this
        viewport, which is where a viewport control belongs.

        The pointer events are stopped: a press on it is not the start of a pan, and the double
        click that fits the picture must not fire twice because the button was under the pointer.
      -->
      <Transition name="fade">
        <button
          v-if="touched"
          type="button"
          class="btn btn-xs absolute top-2 right-2 z-10 gap-1"
          @click="reset"
          @pointerdown.stop
          @dblclick.stop
        >
          <Crosshair class="size-3.5" />
          {{ t('graph.reset') }}
        </button>
      </Transition>

      <div
        class="origin-top-left"
        :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }"
      >
        <svg
          :viewBox="`0 0 ${graph.width} ${graph.height}`"
          :width="graph.width"
          :height="graph.height"
          role="img"
          :aria-label="t('graph.hint')"
        >
        <!-- Edges first, so a node always sits on top of the lines that reach it. -->
        <g fill="none" stroke-width="1.5">
          <path
            v-for="link in graph.links"
            :key="link.id"
            :d="curve(link)"
            :class="STROKE[link.health]"
            :stroke-dasharray="link.health === 'down' ? '4 4' : undefined"
          />
        </g>

        <!--
          The packets. `animateMotion` rather than a JS loop: the browser runs it off the main
          thread, so a fleet of a hundred edges costs no frames, and it stops dead under
          prefers-reduced-motion instead of being throttled.
        -->
        <g v-if="!still">
          <template v-for="link in graph.links" :key="`p-${link.id}`">
            <circle
              v-for="(delay, index) in offsets(link)"
              :key="index"
              r="2.5"
              :class="FILL[link.health]"
            >
              <animateMotion
                :dur="`${SPEED[link.health]}s`"
                :begin="`${delay}s`"
                repeatCount="indefinite"
                :path="curve(link)"
                keyPoints="0;1"
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          </template>
        </g>

        <g v-for="node in graph.nodes" :key="node.id">
          <!--
            Hosts and agents go somewhere; Osmium is the page you are already on. A `<g>` that is
            not a link still gets the same shape, so the tiers read as one family.
          -->
          <component
            :is="node.kind === 'osmium' ? 'g' : 'a'"
            :href="href(node)"
            class="group"
            :class="node.kind === 'osmium' ? '' : 'cursor-pointer'"
            @click="open($event, node)"
          >
            <title>{{ node.label }}{{ node.detail ? ` · ${node.detail}` : '' }}</title>
            <circle
              :cx="node.at.x"
              :cy="node.at.y"
              :r="node.kind === 'agent' ? 6 : 9"
              class="fill-base-100 group-hover:fill-base-300 transition-colors"
              :class="RING[node.health]"
              stroke-width="2"
            />
            <!--
              Written outward: the left half of the picture reads right-to-left away from Osmium,
              the right half reads left-to-right. Every label points the same way as the tier it
              belongs to, and neither side writes its names back over the middle of the diagram.
            -->
            <text
              :x="node.at.x + (mirrored(node) ? -1 : 1) * (node.kind === 'agent' ? 12 : 16)"
              :y="node.at.y + 4"
              :text-anchor="mirrored(node) ? 'end' : 'start'"
              class="fill-base-content text-xs select-none"
              :class="node.health === 'down' ? 'opacity-40' : 'opacity-80'"
            >
              {{ node.label }}
            </text>
          </component>
        </g>
        </svg>
      </div>
    </div>

    <div
      v-if="!agentStore.hosts.length"
      class="flex flex-col items-center gap-2 py-6 text-sm opacity-60"
    >
      <Share2 class="size-6" />
      <span>{{ t('graph.empty') }}</span>
    </div>

    <p class="flex flex-wrap items-center gap-4 text-xs opacity-50">
      <span class="flex items-center gap-1.5"><Server class="size-3.5" /> {{ t('hosts.title') }}</span>
      <span class="flex items-center gap-1.5"><Agent class="size-3.5" /> {{ t('nav.agents') }}</span>
      <span v-if="still">{{ t('graph.reducedMotion') }}</span>
    </p>
  </div>
</template>
