import type { Agent } from "../agents/types.ts";
import type { Project, ProjectCollection } from "../projects/types.ts";
import type { StreamEvent } from "../streams/types.ts";
import type { WorkerRef } from "../workers/types.ts";

export type CfExecutionContext = {
  exports: ExecutionContext["exports"];
  waitUntil?: ExecutionContext["waitUntil"];
};

export interface UnauthenticatedItx {
  authenticate(input: ItxAuthCredentials): ItxRoot;
}

export interface ItxRoot {
  projects: ProjectCollection;
  whoami(): string;
}

export type ScopedItx = Project | Agent;

export interface ItxCapabilityHost {
  runScript(code: string): Promise<{
    completedEvent: StreamEvent;
    executionId: string;
    result: unknown;
  }>;
  provideCapability(input: {
    path: string[];
    capability: ProvidedCapability;
  }): Promise<CapabilityProvision>;
  revokeCapability(input: RevokeCapabilityInput): Promise<void>;
}

export interface CapabilityProvision extends Disposable {
  readonly path: string[];
  readonly providedAtOffset: number;
  revoke(): Promise<void>;
}

export type FlattenedCapabilityInvocation = {
  args: unknown[];
  path: string[];
};

export type FlattenedCapabilityTarget = {
  invokeCapability(input: FlattenedCapabilityInvocation): unknown;
};

export type ProvidedCapability =
  | { flattenNestedPath?: false; target: unknown; type: "live" }
  | { flattenNestedPath: true; target: FlattenedCapabilityTarget; type: "live" }
  | { flattenNestedPath?: boolean; type: "worker"; workerRef: WorkerRef };

export type CapabilityProvidedPayload =
  | {
      flattenNestedPath?: boolean;
      type: "live";
      path: string[];
    }
  | {
      flattenNestedPath?: boolean;
      type: "worker";
      path: string[];
      workerRef: WorkerRef;
    };

export type CapabilityRecord = CapabilityProvidedPayload & {
  providedAtOffset: number;
};

export type RevokeCapabilityInput = {
  path: string[];
  providedAtOffset?: number;
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
