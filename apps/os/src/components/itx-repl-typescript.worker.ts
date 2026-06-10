import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { createWorker } from "@valtown/codemirror-ts/worker";
import * as Comlink from "comlink";
import ts from "typescript";

const REPL_SOURCE_PATH = "/repl.ts";
const REPL_TYPES_PATH = "/iterate-repl-globals.d.ts";

const compilerOptions: ts.CompilerOptions = {
  allowSyntheticDefaultImports: true,
  lib: ["es2022", "dom"],
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
};

// Ambient declarations for REPL autocomplete. This is the itx surface as the
// editor sees it — keep in sync with src/itx/handle.ts (the runtime truth).
const itxDeclaration = `
declare class RpcTarget {}

type JsonRecord = Record<string, unknown>;

/** Anything not declared here resolves through the capability fallthrough. */
type CapSurface = {
  (...args: any[]): Promise<unknown>;
  [segment: string]: CapSurface;
};

interface ProjectSummary {
  id: string;
  slug: string;
}

interface ItxProjects {
  create(input: { id?: string; slug: string }): Promise<ProjectSummary>;
  get(projectIdOrSlug: string): Promise<Itx>;
  list(input?: { limit?: number; offset?: number }): Promise<{ projects: ProjectSummary[]; total: number }>;
  remove(input: { id: string }): Promise<{ ok: true; id: string; deleted: boolean }>;
}

interface CapDescription {
  name: string;
  kind: "live" | "rpc" | "url";
  invoke: "members" | "path-call";
  owner: string;
  connected?: boolean;
}

interface CapSource {
  cacheKey: string;
  mainModule: string;
  modules: Record<string, string>;
  entrypoint?: string;
  exportType?: "worker-entrypoint" | "durable-object";
}

type CapTarget =
  | {
      type: "rpc";
      worker:
        | { type: "binding"; binding: string }
        | { type: "loopback" }
        | { type: "source"; source: CapSource };
      entrypoint?: string;
      props?: JsonRecord;
    }
  | { type: "url"; url: string; headers?: Record<string, string> };

interface ItxCaps {
  provide(input: { name: string; target: RpcTarget | Function | JsonRecord; invoke?: "members" | "path-call" }): Promise<{ name: string; ok: true }>;
  define(input: { name: string; target: CapTarget; invoke?: "members" | "path-call"; meta?: JsonRecord }): Promise<{ name: string; ok: true }>;
  revoke(input: { name: string }): Promise<{ name: string; ok: true }>;
  describe(): Promise<CapDescription[]>;
}

interface ItxStream {
  append(event: JsonRecord): Promise<{ offset: number } & JsonRecord>;
  appendBatch(events: JsonRecord[]): Promise<unknown>;
  describe(): { namespace: string; path: string };
  getState(): Promise<unknown>;
  listChildren(): Promise<unknown>;
  read(input?: JsonRecord): Promise<Array<{ type: string; payload: JsonRecord } & JsonRecord>>;
}

interface ItxStreams {
  create(input: { streamPath: string }): Promise<unknown>;
  get(path: string): ItxStream;
}

interface ItxWorkspaceGit {
  add(input: JsonRecord): Promise<unknown>;
  clone(input: JsonRecord): Promise<unknown>;
  commit(input: JsonRecord): Promise<unknown>;
  push(input: JsonRecord): Promise<unknown>;
  status(input: JsonRecord): Promise<unknown>;
}

interface ItxWorkspace {
  readonly git: ItxWorkspaceGit;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
}

interface ItxProjectAdmin {
  callConfigWorkerFunction(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  describe(): Promise<ProjectSummary & { ingressUrl: string }>;
  egressFetch(request: Request): Promise<Response>;
  fetch(request: Request): Promise<Response>;
  ingressUrl(): Promise<string>;
}

interface Itx {
  readonly caps: ItxCaps;
  readonly project: ItxProjectAdmin;
  readonly projects: ItxProjects;
  readonly repos: CapSurface;
  readonly streams: ItxStreams;
  readonly worker: CapSurface;
  readonly workspace: ItxWorkspace;
  describe(): Promise<JsonRecord>;
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  /** Capabilities by name: itx.slack.chat.postMessage(...), itx.todo.add(...) */
  [capName: string]: CapSurface;
}

declare const itx: Itx;
declare const env: JsonRecord;
declare let $_: unknown;
declare let _: unknown;
`;

Comlink.expose(
  createWorker(async () => {
    const fsMap = await createDefaultMapFromCDN(compilerOptions, ts.version, false, ts);
    fsMap.set(REPL_TYPES_PATH, itxDeclaration);
    fsMap.set(REPL_SOURCE_PATH, "\n");
    const system = createSystem(fsMap);
    return createVirtualTypeScriptEnvironment(
      system,
      [REPL_TYPES_PATH, REPL_SOURCE_PATH],
      ts,
      compilerOptions,
    );
  }),
);
