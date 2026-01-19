import type { MachineType } from "../db/schema.ts";

export interface CreateMachineConfig {
  machineId: string;
  name: string;
  envVars: Record<string, string>;
}

export interface MachineProviderResult {
  externalId: string;
  metadata?: Record<string, unknown>;
}

/** Display info for the machine type */
export interface MachineDisplayInfo {
  /** Human-readable label for the machine type */
  label: string;
  /** Whether to highlight this type (e.g., dev-only types shown in orange) */
  isDevOnly?: boolean;
}

/** Shell commands for interacting with the machine - only includes available commands */
export interface MachineCommands {
  /** Command to open a terminal shell (e.g., `docker exec -it <id> /bin/bash`) */
  terminalShell?: string;
  /** Command to tail daemon logs */
  daemonLogs?: string;
  /** Command to tail opencode logs */
  opencodeLogs?: string;
  /** Command to view container/entry logs */
  entryLogs?: string;
  /** Command to check s6 service status */
  serviceStatus?: string;
}

/** Terminal option for accessing the machine */
export interface TerminalOption {
  label: string;
  url: string;
}

/**
 * Machine provider interface.
 * Providers are instantiated with all context needed (externalId, metadata, etc.)
 * so getters are simple properties computed at construction time.
 *
 * Lifecycle methods still take externalId for cases like:
 * - create() returns a new externalId
 * - delete() after create() fails needs to use the new externalId
 */
export interface MachineProvider {
  readonly type: MachineType;

  // Lifecycle methods - take externalId for flexibility during create/cleanup
  create(config: CreateMachineConfig): Promise<MachineProviderResult>;
  start(externalId: string): Promise<void>;
  stop(externalId: string): Promise<void>;
  restart(externalId: string): Promise<void>;
  archive(externalId: string): Promise<void>;
  delete(externalId: string): Promise<void>;

  // Simple getters - computed at construction time with full context
  readonly previewUrl: string;
  readonly displayInfo: MachineDisplayInfo;
  readonly commands: MachineCommands;
  readonly terminalOptions: TerminalOption[];

  /** Get preview URL for a specific port (for services on different ports) */
  getPreviewUrl(port: number): string;
}
