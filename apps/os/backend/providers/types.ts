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
}

/** A copyable shell command for interacting with the machine */
export interface MachineCommand {
  label: string;
  command: string;
}

/** Terminal option for accessing the machine via web UI */
export interface TerminalOption {
  label: string;
  url: string;
}

/** Provider-level state info (e.g., from Daytona API) */
export interface ProviderState {
  /** Provider-specific state (e.g., "started", "stopped", "destroyed", "error") */
  state: string;
  /** Error reason if state is error */
  errorReason?: string;
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

  // Lifecycle methods - use externalId from construction
  create(config: CreateMachineConfig): Promise<MachineProviderResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  archive(): Promise<void>;
  delete(): Promise<void>;

  // Simple getters - computed at construction time with full context
  readonly previewUrl: string;
  readonly displayInfo: MachineDisplayInfo;
  readonly commands: MachineCommand[];
  readonly terminalOptions: TerminalOption[];

  /** Get preview URL for a specific port (for services on different ports) */
  getPreviewUrl(port: number): string;

  /** Get current state from the provider (optional - not all providers support this) */
  getProviderState?(): Promise<ProviderState>;
}
