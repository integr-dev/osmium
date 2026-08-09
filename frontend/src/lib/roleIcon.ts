import type { Component } from 'vue'
import { CircleSlash2, Eye, ShieldCheck, Workflow } from 'lucide-vue-next'

/**
 * Purely presentational mapping. Role names are hardcoded here on purpose - iconography is a UI
 * concern, and an unknown role degrades to the neutral icon rather than breaking the page.
 */
export function roleIcon(role: string | null | undefined): Component {
  switch (role) {
    case 'viewer':
      return Eye
    case 'orchestrator':
      return Workflow
    case 'administrator':
      return ShieldCheck
    default:
      return CircleSlash2
  }
}
