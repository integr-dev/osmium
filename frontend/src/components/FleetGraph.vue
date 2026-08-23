<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Bot as Agent, Server, Share2 } from 'lucide-vue-next'
import { fleetGraph, type GraphLink, type GraphNode, type LinkHealth } from '../lib/fleetGraph'
import { prefersReducedMotion } from '../lib/motion'
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
function curve(link: GraphLink): string {
  const midX = (link.from.x + link.to.x) / 2
  return `M ${link.from.x} ${link.from.y} C ${midX} ${link.from.y}, ${midX} ${link.to.y}, ${link.to.x} ${link.to.y}`
}

/** Evenly spaced along the edge, so a link reads as a stream rather than a burst. */
function offsets(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index / count) * SPEED.live)
}

/**
 * Where a node goes. `RouterLink` is not used because an anchor it renders inside an `<svg>` lands
 * in the wrong namespace; a real SVG `<a>` with a real href is the thing that works.
 *
 * Which leaves the href doing a full page load on a plain click, so that one case is intercepted
 * and handed to the router. Modified clicks are left alone, because the href is genuine and
 * open-in-new-tab should keep working.
 */
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
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm opacity-60">{{ t('graph.hint') }}</p>
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

    <div class="card border-base-300 bg-base-200 overflow-x-auto border">
      <svg
        :viewBox="`0 0 ${graph.width} ${graph.height}`"
        :style="{ minWidth: '640px', height: `${graph.height}px` }"
        class="w-full"
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
              v-for="(delay, index) in offsets(link.packets)"
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
            <text
              :x="node.at.x + (node.kind === 'osmium' ? 16 : node.kind === 'host' ? 16 : 12)"
              :y="node.at.y + 4"
              class="fill-base-content text-xs"
              :class="node.health === 'down' ? 'opacity-40' : 'opacity-80'"
            >
              {{ node.label }}
            </text>
          </component>
        </g>
      </svg>
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
