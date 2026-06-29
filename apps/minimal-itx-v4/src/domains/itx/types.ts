import type { DynamicWorkerRef } from "../dynamic-workers/types.ts";
import type { ProjectCollection } from "../projects/types.ts";
import type { StreamEvent } from "../streams/types.ts";

export interface UnauthenticatedItx {
  authenticate(input: ItxAuthCredentials): ItxRoot;
}

export interface ItxRoot {
  projects: ProjectCollection;
  whoami(): string;
}

export interface ItxCapabilityHost {
  runScript(code: string): Promise<{
    completedEvent: StreamEvent;
    executionId: string;
    result: unknown;
  }>;
  provideCapability(input: { path: string[]; capability: ProvidedCapability }): Promise<{
    revoke(): void | Promise<void>;
  }>;
  revokeCapability(input: { path: string[] }): void | Promise<void>;
}

export type ProvidedCapability =
  | { type: "live"; target: unknown }
  | { type: "dynamic-worker"; workerRef: DynamicWorkerRef };

export type CapabilityRecord =
  | {
      type: "live";
      path: string[];
    }
  | {
      type: "dynamic-worker";
      path: string[];
      workerRef: DynamicWorkerRef;
    };

export type ItxAuthCredentials =
  | { type: "from-server-cookie" }
  | { type: "token"; token: ItxAuthToken }
  | { type: "trusted-internal"; token: string };

export type ItxAuthToken =
  | { type: "admin"; principal?: string }
  | { type: "user"; principal: string; projectScopes: string[] };

export interface ItxAuth {
  readonly principal: string;
  isAdmin(): boolean;
  canAccessProject(projectId: string): boolean;
  assertCanAccessProject(projectId: string | null): void;
  listAccessibleProjects(): string[];
}
