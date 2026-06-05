/**
 * capnweb-playground — a toy capnweb ("captnweb") capability endpoint at
 * `/api/captnweb`.
 *
 * Everything we're playing with lives in this one file: the capability tree,
 * the scope model, the dynamic-worker (/run) leg, and the request handler.
 *
 * Two RPC systems meet here, and the trick that makes a single capability tree
 * work for both is that capnweb's workers build aliases its own `RpcTarget` to
 * Cloudflare's:
 *
 *   // capnweb/dist/index-workers.js
 *   import * as cfw from "cloudflare:workers";
 *   globalThis[WORKERS_MODULE_SYMBOL] = cfw;
 *   var RpcTarget = workersModule ? workersModule.RpcTarget : class {};
 *
 * So a class that `extends RpcTarget` from "cloudflare:workers" is simultaneously:
 *   1. detected by capnweb as an `rpc-target` and exposed as a live stub over the
 *      WebSocket edge (`newWorkersRpcResponse`), and
 *   2. a real Cloudflare RpcTarget that can be passed by reference into a
 *      WorkerLoader dynamic worker and called with native promise pipelining.
 *
 * Capability constructors take a single props bag (not positional args), per
 * house style (see `WorkerEntrypoint` + `ctx.props` elsewhere in the app).
 *
 * The project data is deliberately a hardcoded/dummy implementation for now —
 * `describe()` echoes the id and `list()` derives ids from the caller's scopes.
 */
import { RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import type { AppConfig } from "~/app.ts";
import { authenticateAdminApiSecret } from "~/auth/middleware.ts";

export const CAPTNWEB_PREFIX = "/api/captnweb";

const PROJECT_SCOPE_PREFIX = "project:";
const PROJECT_WILDCARD = `${PROJECT_SCOPE_PREFIX}*`;

// ── scope helpers (pure) ───────────────────────────────────────────────────

/** Concrete project ids granted by the scopes. Excludes the "*" wildcard. */
function concreteProjectIds(scopes: string[]): string[] {
  return scopes
    .filter((scope) => scope.startsWith(PROJECT_SCOPE_PREFIX))
    .map((scope) => scope.slice(PROJECT_SCOPE_PREFIX.length))
    .filter((id) => id.length > 0 && id !== "*");
}

function authorizesProject(scopes: string[], projectId: string): boolean {
  return (
    scopes.includes(PROJECT_WILDCARD) || scopes.includes(`${PROJECT_SCOPE_PREFIX}${projectId}`)
  );
}

export interface ProjectDescription {
  id: string;
}

// ── the capability tree (every node is an RpcTarget; props passed as a bag) ──

export interface IterateCapabilityProps {
  scopes: string[];
}

export class IterateCapability extends RpcTarget {
  readonly #scopes: string[];
  #projects?: ProjectsCapability;

  constructor(props: IterateCapabilityProps) {
    super();
    this.#scopes = props.scopes;
  }

  // Prototype getter => visible over RPC. Memoised so repeated access is cheap.
  get projects(): ProjectsCapability {
    return (this.#projects ??= new ProjectsCapability({ scopes: this.#scopes }));
  }

  // Super edge case: the "current" project.
  //  - one or more concrete project scopes -> the first one
  //  - no project scopes, or only "project:*" -> none (a wildcard names no
  //    single current project)
  get project(): ProjectCapability | undefined {
    const ids = concreteProjectIds(this.#scopes);
    if (ids.length === 0) return undefined;
    return new ProjectCapability({ projectId: ids[0] });
  }

  async whoami(): Promise<{ scopes: string[] }> {
    return { scopes: this.#scopes };
  }

  async testMethod(input: { behavior?: "return" | "throw"; message?: string }) {
    if (input.behavior === "throw") {
      throw new Error(input.message ?? "testMethod requested failure");
    }
    return { ok: true, message: input.message };
  }
}

export interface ProjectsCapabilityProps {
  scopes: string[];
}

export class ProjectsCapability extends RpcTarget {
  readonly #scopes: string[];

  constructor(props: ProjectsCapabilityProps) {
    super();
    this.#scopes = props.scopes;
  }

  get(projectId: string): ProjectCapability {
    // Enforce the scope before minting the capability, so a caller can't reach
    // a project outside its grant even though the stub proxy "looks like" it
    // has every method.
    if (!authorizesProject(this.#scopes, projectId)) {
      throw new Error(`Not authorized for project: ${projectId}`);
    }
    return new ProjectCapability({ projectId });
  }

  async list(): Promise<string[]> {
    // Dummy: derive directly from the scopes. "project:*" comes through
    // literally for now; a real implementation would enumerate projects from
    // the DB when the wildcard is present.
    return this.#scopes
      .filter((scope) => scope.startsWith(PROJECT_SCOPE_PREFIX))
      .map((scope) => scope.slice(PROJECT_SCOPE_PREFIX.length));
  }
}

export interface ProjectCapabilityProps {
  projectId: string;
}

export class ProjectCapability extends RpcTarget {
  readonly #projectId: string;

  constructor(props: ProjectCapabilityProps) {
    super();
    this.#projectId = props.projectId;
  }

  get id(): string {
    return this.#projectId;
  }

  async describe(): Promise<ProjectDescription> {
    // Dummy hardcoded implementation.
    return { id: this.#projectId };
  }
}

// ── dynamic worker source (loaded via Worker Loader) ────────────────────────
// The parent passes a live scoped `iterate` target into `run`; snippets call it
// just like the WebSocket tests call their local `iterate` stub.
const DEFAULT_DYNAMIC_WORKER_CODE = /* js */ `
async (iterate) => {
  return await iterate.projects.get("proj_alpha").describe();
}
`;

function dynamicWorkerSrc(code: string) {
  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";
  const snippet = (${code});
  export default class extends WorkerEntrypoint {
    run({ iterate }) {
      return snippet(iterate);
    }
  }
`;
}

// ── auth: admin token -> scopes ─────────────────────────────────────────────
// Toy endpoint: only the admin API secret is accepted. The admin may assume any
// scope set via the `x-iterate-scopes` header (comma-separated, e.g.
// "project:proj_abc,project:*"), defaulting to the wildcard. This is what lets
// the e2e tests drive different scope combinations with the admin token.
function resolveCaptnwebScopes(input: { request: Request; config: AppConfig }): string[] | null {
  const principal = authenticateAdminApiSecret({ config: input.config }, input.request);
  if (!principal) return null;

  const header = input.request.headers.get("x-iterate-scopes");
  const parsed =
    header
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) ?? [];
  return parsed.length > 0 ? parsed : [PROJECT_WILDCARD];
}

interface CaptnwebRunEntrypoint {
  run(input: { iterate: IterateCapability }): unknown;
}

function serializeError(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

async function handleRunLeg(input: {
  request: Request;
  url: URL;
  scopes: string[];
  env: Env;
}): Promise<Response> {
  if (!input.env.LOADER) {
    return Response.json({ error: "LOADER binding not available" }, { status: 503 });
  }

  let code = DEFAULT_DYNAMIC_WORKER_CODE;
  if (input.request.method === "POST") {
    const body = (await input.request.json()) as { code?: string };
    if (typeof body.code !== "string" || body.code.trim() === "") {
      return Response.json({ error: "code is required" }, { status: 400 });
    }
    code = body.code;
  }

  const worker = input.env.LOADER.load({
    compatibilityDate: "2026-04-27",
    mainModule: "entry.js",
    modules: { "entry.js": dynamicWorkerSrc(code) },
  });

  const entry = worker.getEntrypoint() as unknown as CaptnwebRunEntrypoint & Partial<Disposable>;
  try {
    const result = await entry.run({
      iterate: new IterateCapability({ scopes: input.scopes }),
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(serializeError(error), { status: 500 });
  } finally {
    entry[Symbol.dispose]?.();
  }
}

/**
 * Raw worker-`fetch`-level handler for the captnweb endpoint. Returns `null`
 * when the request isn't for us, so `entry.workerd.ts` can fall through to the
 * rest of the app. Lives at the worker boundary (not a TanStack route) because
 * the WebSocket upgrade `Response` needs to reach the runtime untouched.
 */
export async function handleCaptnwebFetch(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== CAPTNWEB_PREFIX && !url.pathname.startsWith(`${CAPTNWEB_PREFIX}/`)) {
    return null;
  }

  const scopes = resolveCaptnwebScopes({ request: input.request, config: input.config });
  if (!scopes) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (url.pathname === `${CAPTNWEB_PREFIX}/run`) {
    return handleRunLeg({ request: input.request, url, scopes, env: input.env });
  }

  // capnweb edge: handles the POST batch and the WebSocket upgrade.
  return newWorkersRpcResponse(input.request, new IterateCapability({ scopes }));
}
