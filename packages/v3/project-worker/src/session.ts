// session.ts — the gate and the catalog: what `/api` hands a client BEFORE it holds a context (the
// apps/os shape): `UnauthenticatedSession.authenticate(credentials)` → `Session` → `projects` →
// `list()`, `get(project)`, `create({ project })` — get and create vend the project's ROOT
// `IterateContext`, and `cd(path)` reaches the rest. One session may hold contexts of many projects;
// the SessionTeardown is keyed by context name so they never undo each other's lends.
//   who       — `verifyCredentials`: THE ONE verifier every door shares — `/api` (`authenticate`), the
//               two lanes into a context (worker.ts, the credentials read off a request) and `/mcp`
//               (control-plane.ts `resolveExternalToken`)
//   session teardown — `SessionTeardown`: what a session must undo at its end, one entry per key
//
//   using api = newWebSocketRpcSession("wss://<worker>/api");
//   const itx = api.authenticate({ type: "from-server-cookie" }).projects.get("my-project");
//   const fresh = await api.authenticate({ type: "project-token", token }).projects.get("my-project");
//
// What a session reaches is its `Reach` (control-plane.ts, the directory's word — `reachOf` is the
// one rule, the binding first): the one project a project token or the project secret names, every
// project for the admin secret, org membership for a control-plane user — membership being whatever
// `/login` was told (the demo login form verifies nothing, so a cookie is attribution, not
// authentication). The two project-level doors a session vends ride the root context it hands out:
// `projects.get(project).mintToken()` and `.rotateApiKey()` (iterate-context.ts) — a project-token
// session gets neither.
//
// Every class here is a server-side capnweb RpcTarget (the client is JUST capnweb — iterate-context.ts).
// None of them touches a Durable Object: `projects.get(project)` is addressing (plus the directory's
// reach answer); the first door that reaches a context materializes it.

import { RpcTarget } from "capnweb";
import {
  DurableObjectNameCodec,
  IterateContext,
  type IterateContextNamespace,
  type WaitUntil,
} from "./iterate-context.ts";
import { describeReach, reachOf, type Directory, type Project, type Reach } from "./directory.ts";
import type { AppConfig } from "./app-config.ts";
import { codedError, isSameOriginBrowserRequest } from "./lib.ts";
import {
  verifyAdminSecret,
  verifyProjectSecret,
  verifyProjectToken,
  verifySessionCookie,
  type Principal,
} from "./principal.ts";

/** One DNS-safe name — the directory row, the DO name, the host label; in this deployment a project's
 *  id IS its slug. */
export type ProjectIdOrSlug = string;

/** What a client hands `authenticate` — where its identity already is, or the secret that proves it.
 *  `from-server-cookie`: the control plane's session cookie rode this socket's handshake (a browser
 *  cannot set a header on a WebSocket; the call names the cookie, and the cookie counts on a
 *  same-origin request only). `project-token`: a short-lived signed claim, ONE user on ONE project
 *  (principal.ts — a project host's cookie, a script's bearer). `project-secret`: the project's own
 *  long-lived key (`rotateApiKey` minted it; a device, a headless app) — the session IS the project,
 *  `{ actor: "project:<project>" }`, bound to that one project like a token's.
 *  `admin-secret`: the deployment's `APP_CONFIG_ADMIN_API_SECRET` — every project (the e2e lane,
 *  tooling); with `as`, a user's session without a login: the directory row `email` names, upserted
 *  as `/login` upserts it — its id, `user_<email>`, is the session's actor. */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "project-token"; token: string }
  | { type: "project-secret"; project: ProjectIdOrSlug; secret: string }
  | { type: "admin-secret"; secret: string; as?: { email: string } };

/** Who a session is: a principal, bound to ONE project when it came from a project token or the
 *  project secret (`projectId`). The admin secret's is `{ actor: "admin" }`. */
export type SessionPrincipal = Principal & { projectId?: string };

/** What the two project doors a vended context carries — `mintToken` signs with the configuration's
 *  token secret, `rotateApiKey` writes the key hash to `SECRETS_KV` (iterate-context.ts) — sign
 *  and write with. */
export type ProjectDoorsInput = Pick<SessionInput, "appConfig" | "secretsKv">;

/** What every session is built from: the edge's bindings, the configuration and THIS request. */
export interface SessionInput {
  contextNamespace: IterateContextNamespace;
  waitUntil: WaitUntil;
  directory: Directory;
  /** The request that dialled `/api` — `from-server-cookie` reads the session cookie off it and
   *  checks its `Origin` (`isSameOriginBrowserRequest`, lib.ts). */
  request: Pick<Request, "url" | "headers">;
  /** The deployment's configuration (worker.ts) — the three secrets the credentials verify with:
   *  `projectTokenSecret`, `sessionSecret`, `adminApiSecret`. */
  appConfig: AppConfig;
  /** The `SECRETS_KV` binding — where a project's API-key hash lives (`project-api-key:<projectId>`,
   *  principal.ts), read at `authenticate({ type: "project-secret" })`, written by `rotateApiKey`. */
  secretsKv: KVNamespace;
  /** A live transport tracks projects whose capabilities it has handed out. */
  onProjectAccess?: (projectId: string) => void;
}

/** The principal `credentials` prove, or null when they do not — no reason given, so a door that
 *  tries several kinds in turn (the lanes, `/mcp`) treats every miss alike; `authenticate` names
 *  the miss per kind. A bearer is opaque, so its kind IS its verification: each kind has one
 *  verifier (principal.ts). The cookie counts on a same-origin request only; the admin's `as`
 *  upserts the user's directory row as `/login` does — the row's id is the actor — so membership
 *  works. */
export async function verifyCredentials(
  credentials: SessionCredentials,
  {
    request,
    directory,
    appConfig,
    secretsKv,
  }: Pick<SessionInput, "request" | "directory" | "appConfig" | "secretsKv">,
): Promise<SessionPrincipal | null> {
  switch (credentials.type) {
    case "from-server-cookie": {
      if (!isSameOriginBrowserRequest(request)) return null;
      const claims = await verifySessionCookie(
        request.headers.get("cookie"),
        appConfig.sessionSecret,
      );
      return claims && { actor: claims.sub, email: claims.email };
    }
    case "project-token": {
      const claims = await verifyProjectToken(credentials.token, appConfig.projectTokenSecret);
      if (!claims) return null;
      const { expiresAt: _expiresAt, ...principal } = claims;
      return principal;
    }
    case "project-secret": {
      const principal = await verifyProjectSecret(
        credentials.project,
        credentials.secret,
        secretsKv,
      );
      return principal && { projectId: credentials.project, ...principal };
    }
    case "admin-secret": {
      const admin = await verifyAdminSecret(credentials.secret, appConfig.adminApiSecret);
      if (!admin || !credentials.as) return admin;
      const user = await directory.upsertUser(credentials.as.email);
      return { actor: user.id, email: user.email };
    }
  }
}

/** What `/api` serves: nothing but the gate. The ROOT capnweb target, so its lifetime IS the
 *  socket's — capnweb disposes it when the client's session ends, and that is when every stub this
 *  session lent is recalled (the DO-side stubs die with their session instead of lying in the
 *  presence list). */
export class UnauthenticatedSession extends RpcTarget {
  readonly #sessionTeardown = new SessionTeardown(); // held for the session so lent stubs + pager sockets aren't GC'd
  readonly #input: SessionInput;

  constructor(input: SessionInput) {
    super();
    this.#input = input;
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  /** THE introduction door (the `authenticate()` pattern: the only way to hold authority is to be
   *  handed it by a gate that checked something): `verifyCredentials`, or the refusal coded per
   *  kind — the cookie on a cross-origin browser request, or no cookie at all, is
   *  `UNAUTHENTICATED`; a token or a secret that does not verify is `INVALID_CREDENTIALS`, whatever
   *  is wrong with it. What verified sets the session's reach (`reachOf`, control-plane.ts): the
   *  one project a token or the secret names, every project for the admin secret, the projects of
   *  their orgs for a user (the cookie, the admin's `as`). A project token is a delegation, minutes
   *  long — its session mints no token and rotates no key (the project doors are the member's, the
   *  admin's and the project's own). */
  async authenticate(credentials: SessionCredentials): Promise<Session> {
    if (credentials.type !== "admin-secret")
      throw codedError("INVALID_CREDENTIALS", "The operator RPC door requires the admin secret.");
    const principal = await verifyCredentials(credentials, this.#input);
    if (!principal) throw codedError("INVALID_CREDENTIALS", "The admin secret did not match.");
    return new Session(
      this.#input,
      this.#sessionTeardown,
      principal,
      reachOf(principal),
      this.#input,
    );
  }
}

/** What you authenticate into: a catalog that vends contexts. A session is NOT a context — it is
 *  the directory you reach one through (apps/os: "a session is what authenticate() returns"). */
export class Session extends RpcTarget {
  readonly #sessionTeardown: SessionTeardown;
  readonly #projects: ProjectCollection;
  readonly #principal: SessionPrincipal;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    principal: SessionPrincipal,
    reach: Reach,
    projectDoors: ProjectDoorsInput | null,
  ) {
    super();
    this.#principal = principal;
    this.#sessionTeardown = sessionTeardown;
    this.#projects = new ProjectCollection(input, sessionTeardown, principal, reach, projectDoors);
  }

  [Symbol.dispose](): void {
    this.#sessionTeardown.disposeAll();
  }

  /** Who this session is: the user (the cookie's, the admin's `as`), the token's principal (and its
   *  project), the project itself (`{ projectId, actor: "project:<projectId>" }`), or
   *  `{ actor: "admin" }`. */
  whoami(): SessionPrincipal {
    return this.#principal;
  }

  /** The project catalog. A GETTER, not a field: capnweb (like Workers RPC) exposes prototype
   *  members only — an instance property is private state and is refused over the wire. */
  get projects(): ProjectCollection {
    return this.#projects;
  }
}

/** The project catalog: `list()`, `get(project)`, `create({ project })` — get and create vend the
 *  project's root context. What a session reaches is its `Reach` (control-plane.ts): every project,
 *  the projects of the user's orgs, or the projects named outright. */
class ProjectCollection extends RpcTarget {
  readonly #input: SessionInput;
  readonly #sessionTeardown: SessionTeardown;
  readonly #reach: Reach;
  /** The principal a context stamps on events: the session's, minus the token's binding. */
  readonly #contextPrincipal: Principal;
  /** What the project doors a vended context carries (`mintToken`, `rotateApiKey`) sign and write
   *  with — null for a project-token session, whose contexts carry neither. */
  readonly #projectDoors: ProjectDoorsInput | null;

  constructor(
    input: SessionInput,
    sessionTeardown: SessionTeardown,
    principal: SessionPrincipal,
    reach: Reach,
    projectDoors: ProjectDoorsInput | null,
  ) {
    super();
    this.#input = input;
    this.#sessionTeardown = sessionTeardown;
    this.#reach = reach;
    this.#projectDoors = projectDoors;
    const { projectId: _boundProjectId, ...contextPrincipal } = principal;
    this.#contextPrincipal = contextPrincipal;
  }

  /** The projects this session reaches, as directory rows: the projects of the orgs the user
   *  belongs to, with their role; the one project a bound session names (its row, no role — none
   *  when the directory never heard of it); for the admin secret, every project (no role). */
  list(): Promise<Project[]> {
    return this.#input.directory.reachableProjects(this.#reach);
  }

  /** Create the project named `project` (slugified: that IS its id) — in the user's org (the first
   *  by name when they have several, created on first use when they have none), or in the
   *  deployment's own org for the admin secret — and vend its root context. A bound session (a
   *  project token, the project secret) creates none: FORBIDDEN. A name ANY org already holds is
   *  refused, coded (PROJECT_NAME_TAKEN); the same org's again is idempotent. */
  async create(input: { project: ProjectIdOrSlug }): Promise<IterateContext> {
    const project = await this.#input.directory.createProject(this.#reach, input.project);
    return this.#context(project.id);
  }

  /** The project's root context ("/") — and, on it, the project's two session doors: `mintToken()`
   *  and `rotateApiKey()` (iterate-context.ts), gated by this very admission. A project only — a
   *  context name belongs to `cd`. Outside this session's reach is FORBIDDEN. */
  async get(project: ProjectIdOrSlug): Promise<IterateContext> {
    const address = DurableObjectNameCodec.parse(project);
    if (address.path !== "/")
      throw new Error(
        `projects.get(project): got a context name ${JSON.stringify(project)} — pass the project and cd(path) from its root`,
      );
    if (!(await this.#input.directory.reachesProject(this.#reach, address.projectId)))
      throw codedError(
        "FORBIDDEN",
        `projects.get(${JSON.stringify(project)}): outside this session's reach — ${describeReach(this.#reach)}`,
      );
    return this.#context(address.projectId);
  }

  #context(projectId: string): IterateContext {
    this.#input.onProjectAccess?.(projectId);
    return new IterateContext(
      this.#input.contextNamespace,
      DurableObjectNameCodec.parse(projectId),
      this.#sessionTeardown,
      this.#input.waitUntil,
      this.#contextPrincipal,
      this.#projectDoors,
    );
  }
}

// ── session teardown ── WHAT A SESSION MUST UNDO AT ITS END, as a leaf (no imports): the one-entry-per-key
// register every IterateContext of a session shares, testable in the node lane.

/** WHAT THIS SESSION MUST UNDO AT ITS END — ONE entry per key: a lend relay (the session's copy of
 *  a client stub plus its pager socket, held so neither is GC'd) and anything else scoped to the
 *  session. THE CALLER OWNS THE KEY (iterate-context.ts `#sessionTeardownKey` pairs the context name
 *  with the stub key). Re-adding the SAME key is a TRANSPORT REPLACEMENT (a reconnect): by the time
 *  the new relay's pager is open, the DO has already dropped the old transport as "replaced", so
 *  disposing the incumbent here is a harmless double-close that keeps this map from accumulating
 *  dead relays. */
export class SessionTeardown {
  readonly #undoByKey = new Map<string, { dispose(): void }>();
  /** Register `undo` under `key`, REPLACING what sat there (disposed now). Returns the LEASE — the
   *  one thing a handle should hold: its dispose runs `undo` only while `undo` is still the current
   *  entry, so a stale handle (re-provide at the same match, then dispose the OLD handle) can never tear
   *  down its replacement (the v4 review's kernel finding 2.6). */
  add(key: string, undo: { dispose(): void }): { dispose(): void } {
    this.#undoByKey.get(key)?.dispose();
    this.#undoByKey.set(key, undo);
    return {
      dispose: () => {
        if (this.#undoByKey.get(key) !== undo) return; // replaced — the replacement owns the key now
        this.#undoByKey.delete(key);
        undo.dispose();
      },
    };
  }
  /** Dispose whatever sits under `key` now — the SESSION's own act (a `provide(match, null)`, a
   *  `subscribe` re-spelled as an expression), never a handle's. */
  dispose(key: string): void {
    const undo = this.#undoByKey.get(key);
    if (!undo) return;
    this.#undoByKey.delete(key);
    undo.dispose();
  }
  disposeAll(): void {
    for (const undo of this.#undoByKey.values()) undo.dispose();
    this.#undoByKey.clear();
  }
}
