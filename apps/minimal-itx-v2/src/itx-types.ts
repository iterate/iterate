import type { RpcStub } from "capnweb";
import type {
  StreamEvent,
  StreamEventInput,
} from "@iterate-com/os/src/domains/streams/engine/shared/event.ts";

export type { StreamEvent, StreamEventInput };
export type { RpcCompatible, RpcStub } from "capnweb";

export type ProvideCapabilityInput = {
  capability: unknown;
  path: string[];
};

export type RunScriptResult = {
  completedEvent: StreamEvent;
  executionId: string;
  result: unknown;
};

export type ItxProcessorRpc = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): unknown;
  provideCapability(input: ProvideCapabilityInput): unknown;
  revokeCapability(input: { path: string[] }): void | Promise<void>;
  runScript(input: { code: string }): RunScriptResult | Promise<RunScriptResult>;
};

export type ItxVerbsRpc = {
  provideCapability(input: ProvideCapabilityInput): Promise<{
    revoke(): void | Promise<void>;
  }>;
  revokeCapability(input: { path: string[] }): void | Promise<void>;
  runScript(input: { code: string }): RunScriptResult | Promise<RunScriptResult>;
};

export type StreamRpc = {
  append(args: {
    streamPath?: string;
    event: StreamEventInput;
  }): StreamEvent | Promise<StreamEvent>;
  appendBatch(args: {
    streamPath?: string;
    events: StreamEventInput[];
  }): StreamEvent[] | Promise<StreamEvent[]>;
  create(input?: Record<string, unknown>): StreamEvent | Promise<StreamEvent>;
  getEvents(args?: {
    afterOffset?: number;
    beforeOffset?: number | null;
    limit?: number;
  }): StreamEvent[] | Promise<StreamEvent[]>;
};

export type RepoRpc = {
  create(input?: Record<string, unknown>): StreamEvent | Promise<StreamEvent>;
  whoami(): string | Promise<string>;
};

export type ProjectRpc = {
  egress(url: string, init?: RequestInit): Response | Promise<Response>;
  repo(): RepoRpc;
};

export type AgentRpc = {
  create(input?: Record<string, unknown>): StreamEvent | Promise<StreamEvent>;
  project(): ProjectRpc;
  sendMessage(input: { channel?: string; message: string }): unknown;
  whoami(): string | Promise<string>;
};

export type StreamsRpc = {
  create(input: { path: string } & Record<string, unknown>): StreamEvent | Promise<StreamEvent>;
  get(path: string): StreamRpc;
};

export type ReposRpc = {
  create(input: { path: string } & Record<string, unknown>): StreamEvent | Promise<StreamEvent>;
  get(path: string): RepoRpc;
};

export type AgentsRpc = {
  create(input: { path: string } & Record<string, unknown>): StreamEvent | Promise<StreamEvent>;
  get(path: string): AgentRpc;
};

export type ProjectItxRpc = ItxVerbsRpc & {
  agents: AgentsRpc;
  project: ProjectRpc;
  repo: RepoRpc;
  repos: ReposRpc;
  streams: StreamsRpc;
};

export type AgentItxRpc = ProjectItxRpc & {
  agent: AgentRpc;
};

export type RootProjectsRpc = {
  create(projectId: string): { id: string } | Promise<{ id: string }>;
  list(): string[] | Promise<string[]>;
};

export type RootRpc = {
  projects: RootProjectsRpc;
};

// Server targets implement the plain interfaces above. Client code can wrap the
// same interfaces in Cap'n Web's RpcStub<T>, which stubbifies properties and
// method returns for pipelining.
export type ProjectItxClient = RpcStub<ProjectItxRpc>;
export type RootItxClient = RpcStub<RootRpc>;
