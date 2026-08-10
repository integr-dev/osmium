/**
 * Human-readable names for permission nodes.
 *
 * Presentational only - the raw node string stays the source of truth and is what the API
 * authorizes against. An unmapped node falls back to its own id, so a node added on the backend
 * still renders rather than disappearing.
 */
const LABELS: Record<string, string> = {
  'user.read.self': 'View own account',
  'user.edit.self': 'Rename own account',
  'user.read': 'View all accounts',
  'user.edit': 'Edit any account',
  'user.create': 'Create accounts',
  'user.delete': 'Delete accounts',
  'user.role.write': 'Assign roles',
  'role.read': 'View roles',
  'audit.read': 'View the audit log',
  'agent.read': 'View hosts and bots',
  'agent.control': 'Manage and control bots',
  'agent.chat': 'Speak in game as a bot',
  'agent.login': 'Enrol hosts and set up bots',
}

export function nodeLabel(node: string): string {
  return LABELS[node] ?? node
}
