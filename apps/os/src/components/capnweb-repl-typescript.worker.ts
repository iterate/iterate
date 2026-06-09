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

const iterateContextDeclaration = `
declare class RpcTarget {}

type JsonRecord = Record<string, unknown>;

interface ProjectListItem {
  id: string;
  slug: string;
  customHostname: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isOrphanedProjectFromAuthService: boolean;
}

interface ProjectListResult {
  projects: ProjectListItem[];
  total: number;
}

interface ProjectWithIngressUrl extends ProjectListItem {
  ingressUrl: string;
}

interface ProjectsCapability {
  create(input: { id?: string; slug: string }): Promise<ProjectWithIngressUrl>;
  find(input: { id: string }): Promise<ProjectWithIngressUrl>;
  findBySlug(input: { slug: string }): Promise<ProjectWithIngressUrl>;
  get(projectId: string): ProjectCapability;
  list(input?: { limit?: number; offset?: number }): Promise<ProjectListResult>;
  remove(input: { id: string }): Promise<{ ok: true; id: string; deleted: boolean }>;
}

interface ProjectCapability {
  readonly connections: ProjectConnectionsCapability;
  readonly repos: ProjectReposCapability;
  readonly streams: ProjectStreamsCapability;
  readonly worker: ProjectWorkerCapability;
  readonly workspace: ProjectWorkspaceCapability;

  afterAppend(...args: unknown[]): Promise<unknown>;
  callConfigWorkerFunction(...args: unknown[]): Promise<unknown>;
  createProject(...args: unknown[]): Promise<unknown>;
  describe(...args: unknown[]): Promise<unknown>;
  egressFetch(...args: unknown[]): Promise<Response>;
  fetch(...args: unknown[]): Promise<Response>;
  getCapability(...args: unknown[]): Promise<unknown>;
  getConfigWorker(...args: unknown[]): Promise<unknown>;
  getConnection(...args: unknown[]): Promise<unknown>;
  getIterateContext(...args: unknown[]): Promise<unknown>;
  getProjectLifecycleRunnerState(...args: unknown[]): Promise<unknown>;
  getSummary(...args: unknown[]): Promise<unknown>;
  ingressFetch(...args: unknown[]): Promise<Response>;
  ingressUrl(...args: unknown[]): Promise<string>;
  provideCapability(input: { connectionKey: string; rpcTarget: RpcTarget }): Promise<unknown>;
}

interface ProjectConnectionsCapability {
  get<T extends Record<string, (...args: any[]) => Promise<unknown>> = Record<string, (...args: any[]) => Promise<unknown>>>(
    connectionKey: string,
  ): T;
}

interface ProjectReposCapability {
  create(input: { projectSlug?: string; slug: string }): Promise<unknown>;
  createInfo(input: { projectSlug?: string; slug: string }): Promise<unknown>;
  ensureIterateConfigInfo(input: { projectSlug: string | null }): Promise<unknown>;
  get(input: { slug: string }): Promise<unknown>;
  getInfo(input: { slug: string }): Promise<unknown>;
  list(): Promise<unknown>;
}

interface ProjectStreamsCapability {
  append(input: JsonRecord): Promise<unknown>;
  appendBatch(input: JsonRecord): Promise<unknown>;
  create(input: JsonRecord): Promise<unknown>;
  getState(input: JsonRecord): Promise<unknown>;
  list(): Promise<unknown>;
  listChildren(input: JsonRecord): Promise<unknown>;
  read(input: JsonRecord): Promise<unknown>;
}

interface ProjectWorkspaceCapability {
  readonly git: ProjectWorkspaceGitCapability;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
}

interface ProjectWorkspaceGitCapability {
  add(input: JsonRecord): Promise<unknown>;
  clone(input: JsonRecord): Promise<unknown>;
  commit(input: JsonRecord): Promise<unknown>;
  push(input: JsonRecord): Promise<unknown>;
  status(input: JsonRecord): Promise<unknown>;
}

interface ProjectWorkerCapability {
  fetch(request: Request): Promise<Response>;
  [functionName: string]: (...args: any[]) => Promise<unknown>;
}

interface IterateContext {
  readonly project: ProjectCapability;
  readonly projects: ProjectsCapability;
  readonly repos: ProjectReposCapability;
  readonly streams: ProjectStreamsCapability;
  readonly worker: ProjectWorkerCapability;
  readonly workspace: ProjectWorkspaceCapability;
  getMounted(path: string[]): unknown;
  resolveDynamicWorkerTarget(target: JsonRecord): unknown;
}

declare const ctx: IterateContext;
declare const env: JsonRecord;
declare let $_: unknown;
declare let _: unknown;
`;

Comlink.expose(
  createWorker(async () => {
    const fsMap = await createDefaultMapFromCDN(compilerOptions, ts.version, false, ts);
    fsMap.set(REPL_TYPES_PATH, iterateContextDeclaration);
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
