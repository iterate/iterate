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

/** Terminal access type */
export type TerminalType = "native" | "proxy";

/** Terminal option for accessing the machine */
export interface TerminalOption {
  type: TerminalType;
  label: string;
}

export interface MachineProvider {
  readonly type: MachineType;
  create(config: CreateMachineConfig): Promise<MachineProviderResult>;
  start(externalId: string): Promise<void>;
  stop(externalId: string): Promise<void>;
  restart(externalId: string): Promise<void>;
  archive(externalId: string): Promise<void>;
  delete(externalId: string): Promise<void>;
  getPreviewUrl(externalId: string, metadata?: Record<string, unknown>, port?: number): string;
  /** Get display info for the machine, including dynamic label based on metadata */
  getDisplayInfo(metadata?: Record<string, unknown>): MachineDisplayInfo;
  /** Get shell commands for interacting with the machine */
  getCommands(metadata?: Record<string, unknown>): MachineCommands;
  /** Get available terminal options for this machine type */
  getTerminalOptions(): TerminalOption[];
}
