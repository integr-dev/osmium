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
  'fleet.read': 'View hosts and agents',
  'fleet.control': 'Manage and control agents',
  'fleet.chat': 'Speak in game as an agent',
  'fleet.login': 'Enrol hosts and set up agents',
}

export function nodeLabel(node: string): string {
  return LABELS[node] ?? node
}
