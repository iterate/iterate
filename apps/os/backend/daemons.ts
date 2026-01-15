/**
 * Daemon definitions for machines.
 *
 * Each daemon runs inside the sandbox and may expose a web UI.
 * This is the single source of truth for daemon configuration.
 *
 * Future: could load dynamically from s6-daemons metadata.json files.
 */

export interface DaemonDefinition {
  /** Unique identifier matching s6 service directory name */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Port the daemon listens on inside the container */
  internalPort: number;
  /** Whether this daemon has a web UI */
  hasWebUI: boolean;
  /** Whether requests to this daemon require authentication (default: true) */
  requireAuth?: boolean;
}

export const DAEMON_DEFINITIONS: readonly DaemonDefinition[] = [
  { id: "iterate-daemon", name: "Iterate", internalPort: 3000, hasWebUI: true },
  { id: "opencode", name: "OpenCode", internalPort: 4096, hasWebUI: true, requireAuth: false },
] as const;

/** Get a daemon definition by ID */
export function getDaemonById(id: string): DaemonDefinition | undefined {
  return DAEMON_DEFINITIONS.find((d) => d.id === id);
}

/** Get a daemon definition by internal port */
export function getDaemonByPort(port: number): DaemonDefinition | undefined {
  return DAEMON_DEFINITIONS.find((d) => d.internalPort === port);
}

/** Get all daemons that have a web UI */
export function getDaemonsWithWebUI(): DaemonDefinition[] {
  return DAEMON_DEFINITIONS.filter((d) => d.hasWebUI);
}
