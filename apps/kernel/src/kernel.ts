import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import { decodeJwt } from "jose";
import { CONFIG_WORKER_SOURCE } from "./config-worker.ts";
import { wallVerifier, type WallConfig } from "./auth-wall.ts";
import { mintProjectAppSession, verifyProjectAppSessionToken } from "./project-app-session.ts";
import {
  directoryFor,
  type AuthDirectory,
  type Directory,
  type DirectoryConfig,
} from "./directory.ts";
import { routingFor, type RouteConfig, type Routing } from "./routing.ts";
import { handleMcpRequest, type McpProjects, type McpScripting } from "./mcp.ts";
import { capabilityRegistry, execScriptInProject, scriptingAllowed } from "./dynamic.ts";
import { projectEgress, projectSecrets, type PlatformSecret } from "./egress.ts";
import { StreamDurableObject } from "./stream-do.ts";
import { makeMeter, ProjectCapabilities } from "./capabilities.ts";

// Re-export DO classes so the Worker Loader main module exposes them (wrangler `durable_objects` +
// `migrations` reference them by class name). `ProjectEntrypoint` + `ProjectRunner` are exported below
// (accessed via `ctx.exports` loopbacks — no wrangler binding needed).
export { StreamDurableObject } from "./stream-do.ts";

// ---------------------------------------------------------------------------
// The iterate kernel — clean-room, pure-play.
// Findings referenced below as `review #N` live in:
//   ../os/docs/simplification/kernel-review-2026-07-28.md
//
// `fetch` router: hostname -> projectId -> (optionally) verify the caller -> the Worker Loader
// runs a confined config worker, handed ONE props-scoped ProjectEntrypoint as BOTH env.ITX
// (capabilities) and globalOutbound (the one egress door).
//
// Identity is OPTIONAL and WIDE OPEN IS THE DEFAULT: with no `wall` configured every caller is
// anonymous — users don't exist / don't matter — and that's correct. Otherwise the kernel sits behind
// a WALL (Cloudflare Access, an auth.iterate.com forward-auth proxy, Caddy, …) that authenticated the
// human and injected a signed JWT on ingress; the kernel just VERIFIES that JWT (see wall.ts). There is
// NO login in the kernel. Authorization stays a userspace concern (review #5).
// ---------------------------------------------------------------------------

interface Env {
  LOADER: WorkerLoader; // ambient Cloudflare type (review #15 — no more hand-rolled interfaces)
  // Deployment config as ONE JSON knob (see AppConfig). Unset => auth-free default.
  APP_CONFIG?: string;
  // The separately-deployed OS dashboard vessel's origin. NB this is userspace wiring, not a kernel
  // identity knob (review #11) — threaded here only for the skeleton.
  OS_DASHBOARD_ORIGIN?: string;
  // Test-only backdoor (review #1). Enables a forgeable `Bearer session:<who>` verifier so the e2e
  // can assert credential-carrying without an interactive login. NEVER set in a real deployment.
  INSECURE_STUB_AUTH?: string;
  // The REAL auth worker's directory RPC, over a same-account Service binding (hosted only; the
  // `directory: auth.iterate.com` provider reads it). Absent on self-host (open/local directory).
  AUTH?: AuthDirectory;
  // The self-host persistent directory registry (the `directory: kv` provider). A KV namespace where
  // project creation lands — no auth worker involved.
  DIRECTORY_KV?: KVNamespace;
  // The ingress routing table (ADR 0020/0025): a KV of `route:<host> -> {projectId, app}`, written at
  // runtime to point a custom domain / single self-host domain at a project. Absent => config-only
  // routes (AppConfig.routes) + the `<slug>.<hostBase>` convention.
  ROUTING_KV?: KVNamespace;
  // Per-project secret store (`secret:<projectId>:<name>`) + best-effort platform meter counters
  // (`meter:platform:<name>`). Write-only from userspace; resolved at the egress door (egress.ts).
  SECRETS_KV?: KVNamespace;
  // The durable log — one DO instance per (projectId, path), addressed by name (stream-do.ts). The first
  // real runtime capability; a project reaches only its own streams (name derives from the projectId prop).
  STREAM_DO?: DurableObjectNamespace<StreamDurableObject>;
  // Workers AI (this account's) — the `local` source for the `ai` capability. Absent => only `remote`
  // sourcing works (metered first-party AI through the control plane).
  AI?: Ai;
  // HS256 signing secret for project-app-session tokens (the narrow, project-scoped grant the front
  // door mints for a project app — review #3). Absent => that lane is simply off. The demo value lives
  // in wrangler vars; a real deployment supplies it as a Doppler-backed secret, not a committed var.
  PROJECT_APP_SESSION_SECRET?: string;
}

// ---- Caller context: the RAW credential(s) the request carries ----
// A JWT is already self-describing (its iss / claims / signature), so we carry it RAW and never
// re-decode. The kernel VERIFIES at the door (a forged credential never makes the list) and holds
// the raw credential internally. Past the door we publish only non-secret identity (see `published`).
// It's an ARRAY because different lanes yield different credentials (a wall JWT, a project-app-session)
// — in practice one at a time.
type Credential = { format: string; issuer: string } & Record<string, unknown>;
type Caller = { credentials: Credential[] };
type ProjectProps = { projectId: string };

// ---- App config: the deployment knobs, one JSON var. TWO independent, optional authorities: `wall`
// (identity — who, if anyone, an ingress wall authenticated you as) and `directory` (which projects
// exist + who's a member). No wall => wide open; no directory => open. Hosted / self-host / dev differ
// ONLY here. ----
type AppConfig = {
  // The domain projects live under, e.g. "templestein.iterate2.app". Ingress requires
  // `<slug>.<hostBase>` (review #14) so a stray host can't manufacture a project.
  hostBase?: string;
  // A RESERVED control-plane host (ADR 0031), e.g. "iterate.shiterate.com". Ingress resolves it FIRST and
  // serves the CONTROL PLANE (the console + `/api` + `/mcp`) — it is NOT interpreted as a `<slug>` project.
  // So full self-host burns ONE domain: `iterate.<base>` = control plane, `<slug>.<base>` = projects.
  controlPlaneHost?: string;
  wall?: WallConfig; // unset => WIDE OPEN (every caller anonymous); set => verify the wall's ingress JWT
  directory?: DirectoryConfig; // unset => "open" (every project reachable by anyone)
  // Static ingress routes (the config input to the routing table): `host -> {projectId, app}`. Consulted
  // BEFORE the `<slug>.<hostBase>` convention, so a custom domain or a single-project self-host (one
  // domain, no wildcard) needs no wildcard cert — just an entry here (or in ROUTING_KV). ADR 0020/0025.
  routes?: RouteConfig;
  // THE ITERATE-PRODUCT LAYER (ADR 0030, D-C). Everything here is what turns a *generic* control plane
  // into the *iterate hosted product*. Absent => a generic control plane (self-host) with no first-party
  // anything. Grouping it under one key makes the seam a boundary, not a convention: "generic control
  // plane" is literally "config with no `product`". Grows to hold integrations + billing config.
  //   · platformSecrets — first-party keys iterate holds and lets projects use, substituted at the
  //     control-plane egress door, origin-pinned + metered. Each: {name, value, allowedOrigins}.
  product?: {
    platformSecrets?: PlatformSecret[];
  };
  // Per-capability SOURCING (ADR/M3), shown for `ai`: this capability resolves to a DIFFERENT backend by
  // config. `local` = the project worker's own `env.AI` (Workers AI, its account). `remote` = a metered
  // first-party endpoint reached THROUGH the control-plane egress door with a platform secret — i.e.
  // "remote-sourcing a capability" IS "egress through the control plane with a first-party key". Unset =>
  // local. The artifacts binding would carry the same knob.
  ai?:
    | { source: "local"; model?: string }
    | { source: "remote"; endpoint: string; secretName: string; model?: string };
};
function appConfigFrom(env: Env): AppConfig {
  try {
    return JSON.parse(env.APP_CONFIG ?? "") as AppConfig;
  } catch {
    return {}; // no config => wide open + open directory (the default)
  }
}

type Verifier = (request: Request) => Promise<Credential | null> | Credential | null;

// review #1: forgeable, so it exists ONLY when INSECURE_STUB_AUTH is set (the test config) — a stand-in
// "wall" for the e2e. No real deployment sets that flag, so it's never reachable in prod.
const stubSessionVerifier: Verifier = (request) => {
  const who = /^Bearer\s+session:(.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return who ? { format: "bearer-stub", issuer: "stub", subject: who } : null;
};

// The identity verifiers: the ingress wall's JWT (if a wall is configured) plus the test stub (if on).
// No wall => everyone anonymous (wide open). This is the ~one knob separating hosted / self-host / dev.
function verifiersFor(cfg: AppConfig, env: Env): Verifier[] {
  const stub = env.INSECURE_STUB_AUTH ? [stubSessionVerifier] : [];
  return cfg.wall ? [wallVerifier(cfg.wall), ...stub] : stub;
}

// Resolve the AMBIENT caller — the JWT the ingress wall injected on this request (verified), or empty if
// wide open / no wall on this path. This is the serve path's caller AND `/api`'s default. A wall JWT
// rides on a HEADER the browser can't forge (the wall sets it; we verify the signature) — so there's no
// cookie/CSRF concern and no same-origin dance.
async function resolveAmbientCaller(request: Request, cfg: AppConfig, env: Env): Promise<Caller> {
  const found = await Promise.all(verifiersFor(cfg, env).map((verify) => verify(request)));
  return { credentials: found.filter((c): c is Credential => c !== null) }; // empty = anonymous
}

// What authenticate() accepts. The DEFAULT (omit it) is the ambient wall JWT — who the wall says you
// are. The one explicit lane is `project-app-session`: the NARROW, project-scoped grant a project app
// carries instead of the user's session (review #3), verified locally.
type Credentials = { type: "project-app-session"; token: string };

async function resolveCaller(
  credentials: Credentials | undefined,
  request: Request,
  cfg: AppConfig,
  env: Env,
): Promise<Caller> {
  if (credentials?.type === "project-app-session") {
    const secret = env.PROJECT_APP_SESSION_SECRET;
    if (secret === undefined) return { credentials: [] };
    const claims = await verifyProjectAppSessionToken(secret, credentials.token);
    // A VERIFIED project-app-session IS proof that `userId` may act in `projectId` (membership was
    // checked when the front door minted it). The decoded {projectId, userId} is the whole credential.
    return claims
      ? {
          credentials: [
            {
              format: "project-app-session",
              issuer: "kernel",
              projectId: claims.projectId,
              userId: claims.userId,
            },
          ],
        }
      : { credentials: [] };
  }
  return resolveAmbientCaller(request, cfg, env); // default: the wall's ingress JWT (or anonymous)
}

// The caller's stable user id — `sub` on a verified wall JWT, or the stub's `subject`.
// Used to mint a project-app-session (WHO the app acts as). Anonymous callers have none.
function callerUserId(caller: Caller): string | undefined {
  for (const c of caller.credentials) {
    if (typeof c.subject === "string") return c.subject;
    if (typeof c.jwt === "string") {
      const sub = decodeJwt(c.jwt).sub;
      if (typeof sub === "string") return sub;
    }
  }
  return undefined;
}

// review #3: past the door we publish WHO the caller is (issuer / format + any non-secret fields a
// verifier chose to expose), never the raw signed token — a separate origin or HTML must never
// receive a replayable credential. The raw jwt stays kernel-internal (for the future capability path).
function published(caller: Caller): Caller {
  return { credentials: caller.credentials.map(({ jwt, token, ...nonSecret }) => nonSecret) };
}

const CALLER_HEADER = "x-iterate-caller";
const APP_HEADER = "x-iterate-app"; // which app of the project the hostname (<app>--<slug>) selected
const APP_SESSION_HEADER = "x-iterate-app-session"; // the narrow project-app-session minted for the app
const DASHBOARD_APP = "dashboard"; // the ONE kernel-reserved app (control plane) — served by the kernel,
// never the config worker, so a broken config worker can't lock you out of the tool that fixes it.

// Ingress: hostname -> { projectId, app }. Apps are addressed by HOSTNAME, like apps/os:
// `<slug>.<hostBase>` is the project's default (public) app; `<app>--<slug>.<hostBase>` selects a
// named app (each at its own hostname root, so its assets/routes need no base path). One label in
// front of the base (review #14) so stray hosts can't mint projects; no base (local dev) => first label.
function resolveIngress(
  request: Request,
  hostBase?: string,
): { projectId: string; app: string } | null {
  const host = new URL(request.url).hostname;
  let label: string;
  if (hostBase) {
    const suffix = "." + hostBase;
    if (!host.endsWith(suffix)) return null;
    label = host.slice(0, -suffix.length);
    if (!label || label.includes(".")) return null; // exactly one label in front of the base
  } else {
    label = host.split(".")[0];
    if (!label || label === "localhost" || label === "127") return null;
  }
  const dd = label.indexOf("--"); // <app>--<slug>; no `--` => the default app ("")
  return dd === -1
    ? { projectId: label, app: "" }
    : { projectId: label.slice(dd + 2), app: label.slice(0, dd) };
}

// A tiny stable hash of the config-worker source so the loader cache key changes when the config
// changes (review #13). Computed once at module load.
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const CONFIG_HASH = hashSource(CONFIG_WORKER_SOURCE);

// ---- The capability tree over capnweb (RpcTarget), mirroring apps/os exactly — review #6 ----
//   Os.authenticate() -> Session -> Session.projects.get(id) -> Project
// `/api` is the OS front desk (deployment-wide), NOT project-scoped by hostname: authenticate()
// establishes WHO you are, then projects.get(id) scopes to a project the DIRECTORY says you may
// reach. capnweb's RpcTarget IS the cloudflare:workers one, so the same tree is also reachable
// in-worker as env.ITX. Nested capabilities are unforgeable stubs (attenuation).

// A project handle, mirroring apps/os `ProjectRpcTarget`. Either EXISTING (has a projectId) or a
// PROSPECTIVE slug — `get("acme")` on an unknown slug returns a prospective handle whose create()
// births it. `projectId` is a getter (not a method); create() takes `{ organizationSlug?, projectId? }`
// (the slug comes from the get() handle) — apps/os shapes, verbatim. Its capabilities hang here as
// further collections, the same shape as session.projects: `streams.get(path).append()/.subscribe()`,
// `secrets.get(name)`, `fetch` (the egress door) — addressed by path, never `project.append()`.
class Project extends RpcTarget {
  constructor(
    private readonly state:
      | { projectId: string }
      | { prospectiveSlug: string; caller: Caller; directory: Directory },
    private readonly routing: Routing,
    private readonly env: Env,
  ) {
    super();
  }
  get projectId(): string {
    if (!("projectId" in this.state)) {
      throw new Error(
        `project "${this.state.prospectiveSlug}" does not exist — create it with session.projects.get(${JSON.stringify(this.state.prospectiveSlug)}).create({})`,
      );
    }
    return this.state.projectId;
  }
  // THE ONE capability tree (D-A) — the same `ProjectCapabilities` the loopback `env.ITX` exposes.
  // `project.streams.get(path).append()`, `project.secrets.set()`, `project.ai.run()`. Only on an EXISTING
  // project (the getter reads `this.projectId`, which throws for a prospective handle).
  #caps(): ProjectCapabilities {
    return new ProjectCapabilities(
      this.env,
      appConfigFrom(this.env),
      this.projectId,
      makeMeter(this.env.SECRETS_KV),
    );
  }
  get streams() {
    return this.#caps().streams;
  }
  get secrets() {
    return this.#caps().secrets;
  }
  get ai() {
    return this.#caps().ai;
  }
  // Register (birth) a prospective slug. The directory authority owns the write — auth-prd (hosted)
  // or the local KV registry (self-host) — so the SAME call works in both modes; only config differs.
  async create(args: { organizationSlug?: string; projectId?: string } = {}): Promise<Project> {
    if (!("prospectiveSlug" in this.state))
      throw new Error("create() is only available on a prospective project handle");
    const result = await this.state.directory.create(this.state.caller, {
      slug: this.state.prospectiveSlug,
      ...args,
    });
    if (!result.ok) throw new Error(result.reason);
    return new Project({ projectId: result.project.slug }, this.routing, this.env);
  }
  // Point a custom hostname at THIS project — writes the routing table (`route:<host>`), so a custom
  // domain or a single-project self-host domain resolves here (ADR 0020/0025). Needs ROUTING_KV; config
  // routes are read-only. Holding this handle already implies access (the directory gate ran in
  // projects.get), so the mapping is authorized. app defaults to the public app ("").
  async mapHostname(host: string, app = ""): Promise<void> {
    if (!("projectId" in this.state))
      throw new Error("mapHostname is only available on an existing project (create it first)");
    await this.routing.map(host, { projectId: this.state.projectId, app });
  }
}

// session.projects — the membership gate. get(project) returns an EXISTING handle if the directory
// says this caller may reach it, a PROSPECTIVE handle if it's unknown (create() births it), and
// throws only for a real project you're not a member of. Addressing never creates (apps/os).
class ProjectCollection extends RpcTarget {
  constructor(
    private readonly caller: Caller,
    private readonly directory: Directory,
    private readonly routing: Routing,
    private readonly env: Env,
  ) {
    super();
  }
  // `project` is a slug OR a projectId — resolution is the directory's job (for this cut projectId
  // IS the slug, so they coincide; a distinct `prj_…` id is a directory-resolution seam).
  async get(project: string): Promise<Project> {
    // A project-app-session credential is proof of access to ITS project (membership was checked when
    // the front door minted it) — honor it directly, no directory hop (the local fast-path, mirroring
    // apps/os's project-app-session validation). Every other caller goes through the directory.
    if (
      this.caller.credentials.some(
        (c) => c.format === "project-app-session" && c.projectId === project,
      )
    )
      return new Project({ projectId: project }, this.routing, this.env);
    const access = await this.directory.access(this.caller, project);
    if (access.ok) return new Project({ projectId: project }, this.routing, this.env);
    if (!access.exists)
      return new Project(
        {
          prospectiveSlug: project,
          caller: this.caller,
          directory: this.directory,
        },
        this.routing,
        this.env,
      );
    throw new Error(access.reason); // exists, but you're not a member
  }
  async list(): Promise<string[]> {
    return this.directory.list(this.caller);
  }
}

// What authenticate() hands back: the caller's session. Identity is baked in here once (session-
// scoped), which is how the §17 per-call-caller concern dissolves for `/api` (review #9).
class Session extends RpcTarget {
  constructor(
    private readonly resolvedCaller: Caller,
    private readonly directory: Directory,
    private readonly routing: Routing,
    private readonly env: Env,
  ) {
    super();
  }
  // Who you are — secret-stripped (review #3), never the raw signed token.
  caller(): Caller {
    return published(this.resolvedCaller);
  }
  get projects(): ProjectCollection {
    return new ProjectCollection(this.resolvedCaller, this.directory, this.routing, this.env);
  }
}

// The unauthenticated `/api` root (apps/os's UnauthenticatedOs). authenticate(credentials) is the only
// door: the caller declares a lane (or omits it for anonymous — first-class here), the kernel verifies,
// and hands back a Session. Canonical capnweb — authority can't be forged, only returned by a method
// that already checked you.
class Os extends RpcTarget {
  constructor(
    private readonly request: Request,
    private readonly cfg: AppConfig,
    private readonly env: Env,
  ) {
    super();
  }
  async authenticate(credentials?: Credentials): Promise<Session> {
    const caller = await resolveCaller(credentials, this.request, this.cfg, this.env);
    return new Session(
      caller,
      directoryFor(this.cfg, this.env),
      routingFor(this.cfg, this.env),
      this.env,
    );
  }
}

// The in-worker face of the ONE project capability tree — bound as both `env.ITX` (capabilities) and
// `globalOutbound` (the egress door). It stays a WorkerEntrypoint ONLY because a loopback binding +
// globalOutbound require a real `Fetcher.fetch` (D-A). Everything else is the SAME `ProjectCapabilities`
// tree the capnweb `Project` exposes: `env.ITX.streams.get(path).append()`, `.secrets.set()`, `.ai.run()`
// — one authored surface, promise-pipelined over the loopback. The per-request caller rides to the config
// worker as the stamped header (review #9).
export class ProjectEntrypoint extends WorkerEntrypoint<Env, ProjectProps> {
  // Stable capability data (projectId). NOT the caller — that rides per-request (the stamped header).
  whoami(): ProjectProps {
    return this.ctx.props;
  }
  // THE capability tree (identical to the capnweb `Project`'s), scoped to THIS project via the unforgeable
  // projectId prop. `env.ITX.streams` / `.secrets` / `.ai`.
  #caps(): ProjectCapabilities {
    return new ProjectCapabilities(
      this.env,
      appConfigFrom(this.env),
      this.ctx.props.projectId,
      makeMeter(this.env.SECRETS_KV),
    );
  }
  get streams() {
    return this.#caps().streams;
  }
  get secrets() {
    return this.#caps().secrets;
  }
  get ai() {
    return this.#caps().ai;
  }
  // globalOutbound: THE one egress door (review #7) — the ONLY thing that must stay a real `Fetcher.fetch`
  // (WS upgrades need the literal method). A TWO-LEVEL chained door (egress.ts): substitute the project's
  // own secrets, then the control-plane door substitutes platform secrets (origin-pinned + metered).
  async fetch(request: Request): Promise<Response> {
    const cfg = appConfigFrom(this.env);
    const proj = projectSecrets(this.env.SECRETS_KV, this.ctx.props.projectId);
    return projectEgress(
      request,
      proj,
      cfg.product?.platformSecrets ?? [],
      makeMeter(this.env.SECRETS_KV),
    );
  }
}

// ---- THE PROJECT RUNNER (two-worker split, step 1) ----
// A NAMED interface for the two project-scoped operations that are coupled to `ctx.exports` + `env.LOADER`
// (and therefore MUST move together into a separate runner worker in step 2 — see
// wayfinder/two-worker-split-assessment.md): loading + serving the confined config worker, and running an
// ad-hoc script. Today it is a CO-LOCATED loopback entrypoint the control plane reaches via
// `ctx.exports.ProjectRunner()` — no behavior change. In step 2 it becomes a separate worker the control
// plane service-binds (same account) or dials over capnweb (cross-account); the INTERFACE is unchanged.
//
// Step 1's load-bearing experiment: prove `this.ctx.exports.ProjectEntrypoint({props})` works INSIDE a
// WorkerEntrypoint (the runner must mint the per-project ITX loopback itself — in step 2 it's the runner
// worker's OWN export). If this works co-located, the physical split is a binding swap.
export class ProjectRunner extends WorkerEntrypoint<Env> {
  #makeEntry() {
    // ctx.exports on a WorkerEntrypoint's context — the step-1 experiment. Untyped without `wrangler
    // types` (review #15); one explained cast.
    return (
      this.ctx as unknown as {
        exports: { ProjectEntrypoint(o: { props: ProjectProps }): Fetcher };
      }
    ).exports.ProjectEntrypoint;
  }
  // Load + serve the confined config worker for `projectId`, serving app `app`. The control plane has
  // already resolved ingress + wall + directory and passes the non-secret published caller (JSON) to stamp.
  async serve(
    request: Request,
    projectId: string,
    app: string,
    callerHeader: string,
  ): Promise<Response> {
    const projectEntry = this.#makeEntry()({ props: { projectId } });
    const worker = this.env.LOADER.get(`project:${projectId}:${CONFIG_HASH}`, () => ({
      compatibilityDate: "2026-07-01",
      mainModule: "config.js",
      modules: { "config.js": CONFIG_WORKER_SOURCE },
      env: { ITX: projectEntry }, // the config worker sees ONLY the itx capability — the confinement
      globalOutbound: projectEntry, // same object => the egress door shares the capability context
    }));
    const headers = new Headers(request.headers);
    headers.delete(CALLER_HEADER);
    headers.delete(APP_HEADER);
    headers.delete(APP_SESSION_HEADER);
    headers.set(CALLER_HEADER, callerHeader);
    headers.set(APP_HEADER, app);
    return worker.getEntrypoint().fetch(new Request(request, { headers }));
  }
  // Run an ad-hoc script against a project's ITX tree, confined (the os `exec_typescript` model). The CP
  // has already membership-gated + write-gated; the runner owns the loader + the ProjectEntrypoint mint.
  async runScript(projectId: string, code: string, args: unknown): Promise<unknown> {
    return execScriptInProject({
      code,
      projectId,
      args,
      loader: this.env.LOADER,
      makeEntry: this.#makeEntry(),
    });
  }
}

// The runner's control-plane-facing interface (what the CP calls, whatever the transport).
type RunnerStub = {
  serve(request: Request, projectId: string, app: string, callerHeader: string): Promise<Response>;
  runScript(projectId: string, code: string, args: unknown): Promise<unknown>;
};

// THE ONE CHOKEPOINT for reaching the project runner ("the dial"). Today: a co-located loopback
// (`ctx.exports.ProjectRunner()`). In step 2 this is the ONLY line that changes — to a service binding
// (`env.RUNNER`, same account) or a capnweb-dialed remote stub (cross-account). Everything upstream is
// transport-agnostic.
function dialRunner(ctx: ExecutionContext): RunnerStub {
  // `ctx.exports.<Entrypoint>(options)` — the loopback calling convention requires an Options object even
  // when the entrypoint takes no props (mirrors `ProjectEntrypoint({ props })`). Empty options here.
  return (
    ctx as unknown as { exports: { ProjectRunner(o: object): RunnerStub } }
  ).exports.ProjectRunner({});
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cfg = appConfigFrom(env);
    const url = new URL(request.url);
    // `/mcp` — the control-plane MCP surface, a SIBLING to `/api` (ADR 0022). Headless + deployment-wide
    // (no project host needed), so it resolves BEFORE ingress: same wall auth + directory as `/api`,
    // MCP protocol instead of capnweb. (The clean home for both is the control plane's own front door.)
    if (url.pathname === "/mcp") return handleMcp(request, cfg, env, ctx);

    // `/api` — the capnweb front desk (review #6): authenticate() -> session -> projects.get(id).
    // Deployment-wide, HOST-AGNOSTIC (like /mcp) — it resolves BEFORE ingress so it also answers on the
    // control-plane host. `newWorkersRpcResponse` serves the WebSocket upgrade + HTTP batch; auth + the
    // membership check happen lazily inside the tree.
    if (url.pathname === "/api") {
      return newWorkersRpcResponse(request, new Os(request, cfg, env));
    }

    // The RESERVED CONTROL-PLANE HOST (ADR 0031) is resolved BEFORE the project convention: if the request
    // host is `cfg.controlPlaneHost`, this is the control plane's console (create/list projects) — NOT a
    // project named after the label. `/api` + `/mcp` above already answer here; other paths get the console.
    if (cfg.controlPlaneHost && url.hostname === cfg.controlPlaneHost) {
      return serveControlPlane(url.hostname);
    }

    // The ROUTING TABLE resolves the host (config routes, then ROUTING_KV — incl. custom-domain
    // subdomains-as-apps, ADR 0031), then the `<slug>.<hostBase>` convention as the zero-config fallback.
    const ingress =
      (await routingFor(cfg, env).lookup(url.hostname)) ?? resolveIngress(request, cfg.hostBase);
    if (!ingress) return new Response("no project for host\n", { status: 404 });
    const { projectId, app } = ingress;

    // The DASHBOARD is a KERNEL-RESERVED app — the CONTROL PLANE. Like `/api`, the kernel serves it
    // DIRECTLY and never runs the config worker. That's the whole point: the dashboard is the surface
    // you use to MANAGE a project, including recovering from a broken config worker — so it must NOT
    // depend on that (userspace, mutable, breakable) config worker being healthy. Break your config
    // worker and you lose your own apps, never the tool you'd fix them with. It's still AUTHORED like
    // any other app (the OS_DASHBOARD_ORIGIN vessel, same SDK) — only the SERVING is kernel-guaranteed.
    if (app === DASHBOARD_APP) {
      return serveDashboard(request, projectId, url.host, cfg, env);
    }

    const caller = await resolveAmbientCaller(request, cfg, env);

    // Hand off to the PROJECT RUNNER (two-worker split, step 1): the control plane has resolved ingress +
    // wall + directory; the runner owns the loader + the confined config worker. Today a co-located loopback
    // (`ctx.exports.ProjectRunner()`); in step 2 a service-bound / capnweb-dialed separate worker — same
    // call. The non-secret published caller rides as a JSON arg the runner stamps as the trusted header.
    return dialRunner(ctx).serve(request, projectId, app, JSON.stringify(published(caller)));
  },
};

// The reserved control-plane host's console (ADR 0031). A deployment-wide surface (create/list projects),
// NOT a project. `/api` + `/mcp` already answer on this host; this is the human landing. Minimal for now —
// the full control-plane web app (create/list via the /api tree) is the "console" in the two-web-apps
// split. The point proven here: this host OVERRIDES slug interpretation.
function serveControlPlane(host: string): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>iterate control plane</title>` +
      `<body style="font:16px system-ui;max-width:40rem;margin:3rem auto">` +
      `<h1>iterate control plane</h1>` +
      `<p>This is the <b>control plane</b> at <code>${host}</code> — the deployment-wide console, not a ` +
      `project. Create/list projects via <code>/api</code> (capnweb) or <code>/mcp</code> (MCP).</p>` +
      `<p><small>Projects live at <code>&lt;slug&gt;.${host.split(".").slice(1).join(".")}</code>; ` +
      `custom domains route via the control-plane routing table.</small></p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// The `/mcp` handler — build the caller's Session (SAME wall auth + directory as `/api`) and adapt its
// project collection to the MCP tool surface (list/create/get). MCP is a protocol adapter over the same
// front desk the capnweb tree exposes (ADR 0022) — not a second backend.
async function handleMcp(
  request: Request,
  cfg: AppConfig,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const caller = await resolveAmbientCaller(request, cfg, env);
  const collection = new ProjectCollection(
    caller,
    directoryFor(cfg, env),
    routingFor(cfg, env),
    env,
  );
  // WRITE-AUTHORITY gate (R8 follow-up): creating a project is a write. On a WALLED deployment an
  // anonymous `/mcp` caller (a host Access doesn't front) must NOT create projects (spam / cross-tenant
  // rows); wide-open (no wall — LAN/Pi) allows it by design. Same rule as scripting. The authenticated
  // "emerge with a project" flow (ADR 0029) is unaffected — a walled caller is authenticated post-wall.
  // (Deeper: the `auth` multi-tenant directory should also verify org membership on create — needs an
  // auth RPC; tracked as a follow-up.)
  const writeAllowed = scriptingAllowed({
    walled: cfg.wall !== undefined,
    authenticated: caller.credentials.length > 0,
  });
  const projects: McpProjects = {
    list: () => collection.list(),
    async create(slug, organizationSlug) {
      if (!writeAllowed) throw new Error("create requires authentication on a walled deployment");
      const created = await (
        await collection.get(slug)
      ).create(organizationSlug ? { organizationSlug } : {});
      return created.projectId;
    },
    get: async (slug) => (await collection.get(slug)).projectId,
  };
  // Scripting facade — exec runs on the RUNNER (via `dialRunner`, split step 1); capability provide/list
  // are directory-adjacent KV (control-plane-side). Every op resolves the project through the directory
  // first (membership gate); `provide`/`invoke` also honor the write gate.
  const runner = dialRunner(ctx);
  const resolve = async (slug: string) => (await collection.get(slug)).projectId;
  const scripting: McpScripting = {
    async runScript(slug, code, args) {
      return runner.runScript(await resolve(slug), code, args);
    },
    async provideCapability(slug, name, code) {
      const projectId = await resolve(slug);
      await capabilityRegistry(env.SECRETS_KV, projectId).provide(name, code);
    },
    async invokeCapability(slug, name, args) {
      const projectId = await resolve(slug);
      const code = await capabilityRegistry(env.SECRETS_KV, projectId).code(name);
      if (code === null) throw new Error(`no such capability '${name}'`);
      return runner.runScript(projectId, code, args);
    },
    async listCapabilities(slug) {
      const projectId = await resolve(slug);
      return capabilityRegistry(env.SECRETS_KV, projectId).list();
    },
  };
  // SECURITY (thermonuclear review R7 #1): scripting is write+secret+arbitrary-code authority. It must
  // NOT ride the "public reachability" gate. On a WALLED deployment, `/mcp` may be reachable on a host
  // Cloudflare Access doesn't front (Access binds app hostnames; a headless /mcp path gets no SSO
  // redirect) → the caller is anonymous. Refuse scripting for an anonymous caller whenever a wall is
  // configured; on a truly wide-open deployment (no wall — LAN/Pi, open by design) scripting stays on.
  // (For the multi-tenant `auth` directory, resolve()/get() already membership-gates per project.) Same
  // `writeAllowed` rule as create — both are write authority that must not ride public reachability.
  return handleMcpRequest(
    request,
    projects,
    { name: "iterate-kernel", version: "0.1.0" },
    writeAllowed ? scripting : undefined,
  );
}

// Serve the kernel-reserved dashboard (control plane): mint a narrow project-app-session so the vessel
// acts AS the caller scoped to THIS project (review #3 — only for an authenticated member; anonymous
// gets none), then proxy to the OS_DASHBOARD_ORIGIN vessel with the non-secret context stamped. This is
// a kernel-owned fetch, NOT the project's egress door — the control plane isn't subject to the project's
// egress policy. Absent a vessel origin, a minimal inline page stands in (and reports the mint).
async function serveDashboard(
  request: Request,
  projectId: string,
  host: string,
  cfg: AppConfig,
  env: Env,
): Promise<Response> {
  const caller = await resolveAmbientCaller(request, cfg, env);
  let appSession: string | undefined;
  const userId = callerUserId(caller);
  if (env.PROJECT_APP_SESSION_SECRET !== undefined && userId !== undefined) {
    const access = await directoryFor(cfg, env).access(caller, projectId);
    if (access.ok)
      appSession = await mintProjectAppSession(env.PROJECT_APP_SESSION_SECRET, {
        projectId,
        userId,
      });
  }

  const origin = env.OS_DASHBOARD_ORIGIN;
  if (!origin) {
    const who = caller.credentials.map((c) => c.issuer).join(", ") || "anonymous";
    return new Response(
      `<!doctype html><meta charset=utf-8><title>${projectId} · dashboard</title>` +
        `<body style="font:16px system-ui;max-width:40rem;margin:3rem auto">` +
        `<h1>${projectId} · dashboard</h1><p><b>Kernel-served control plane.</b> ` +
        `project-app-session: <b>${appSession ? "present" : "absent"}</b>. you are: <b>${who}</b>.</p>` +
        `<p>Set OS_DASHBOARD_ORIGIN to serve the real vessel here.</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  const url = new URL(request.url);
  const proxied = new Request(new URL(url.pathname + url.search, origin), request);
  // The vessel is a SEPARATE, credential-free origin (review #3): never forward the browser session; it
  // gets only the non-secret caller + the narrow minted session. Strip incoming x-iterate-* forgery.
  proxied.headers.delete("cookie");
  proxied.headers.delete("authorization");
  proxied.headers.delete(APP_SESSION_HEADER);
  proxied.headers.set(CALLER_HEADER, JSON.stringify(published(caller)));
  proxied.headers.set("x-iterate-project-id", projectId);
  proxied.headers.set("x-iterate-project-host", host);
  if (appSession !== undefined) proxied.headers.set(APP_SESSION_HEADER, appSession);
  return fetch(proxied);
}
