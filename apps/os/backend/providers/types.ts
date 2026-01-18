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

/** Capabilities that determine what UI actions are available */
export interface MachineCapabilities {
  /** Has a web-based terminal accessible via native URL */
  hasNativeTerminal: boolean;
  /** Has a web-based terminal accessible via proxy URL */
  hasProxyTerminal: boolean;
  /** Has a docker container that can be accessed via `docker exec` */
  hasDockerExec: boolean;
  /** Has container logs accessible via `docker logs` */
  hasContainerLogs: boolean;
  /** Has s6 service status (sandbox-based machines) */
  hasS6Services: boolean;
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
  /** Get capabilities for determining available UI actions */
  getCapabilities(): MachineCapabilities;
}
