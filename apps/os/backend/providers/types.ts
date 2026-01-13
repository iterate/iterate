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

export interface MachineProvider {
  readonly type: MachineType;
  create(config: CreateMachineConfig): Promise<MachineProviderResult>;
  start(externalId: string): Promise<void>;
  stop(externalId: string): Promise<void>;
  restart(externalId: string): Promise<void>;
  archive(externalId: string): Promise<void>;
  delete(externalId: string): Promise<void>;
  getPreviewUrl(externalId: string, metadata?: Record<string, unknown>, port?: number): string;
}
