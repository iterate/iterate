// The PROJECT WORKER — the stateless edge AND the front door. capnweb terminates at `/api`; a project
// host — the ONE HTTP way into a project — forwards to the IterateContextDurableObject over Workers
// RPC (the DO does the real work and stays hibernatable); the static assets (the console's client
// bundle, the hosted /demo page) are served on the platform host alone; the control plane (OAuth AS +
// D1 directory + /mcp + the console, a TanStack Start app SSR'd in-process) runs IN-PROCESS here
// (control-plane.ts) — one worker, one front door. A project host names its project; the directory
// confirms it exists. Two pure halves ride with the edge:
//   app config   — `appConfigOf` / `parseAppConfig`: THE WORKER'S CONFIGURATION, one typed object per isolate
//   project host — `projectHostOf` + the project-session cookie door: which project and which app a hostname names

import * as cloudflareWorkers from "cloudflare:workers";
import {
  newWorkersRpcResponse,
  RpcPromise as CapnwebRpcPromise,
  RpcStub as CapnwebRpcStub,
} from "capnweb";
import { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
// the one worker's env: the DO's bindings plus the in-process control plane's (control-plane.ts `Env`)
import { directory, controlPlane, type Env as WorkerEnv } from "./control-plane.ts";
import { registerPipelinedRpcBrand } from "./context/expression.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./context/rpc-stubs.ts";
import { DurableObjectNameCodec } from "./iterate-context.ts";
import {
  UnauthenticatedSession,
  verifyCredentials,
  type ProjectIdOrSlug,
  type SessionCredentials,
  type SessionInput,
} from "./session.ts";
import {
  cookieValueOf,
  ITX_PRINCIPAL_HEADER,
  verifyProjectToken,
  type Principal,
} from "./principal.ts";
import { isSameOriginBrowserRequest } from "./lib.ts";

/** A project host's re-entry count — THE COUNT THE APP FORWARDS: an app that fetches its own host
 *  and forwards the headers it was handed re-enters with the count on them, each pass adds one, and
 *  the edge refuses past a few. A fresh Request starts at zero — an app looping its own project
 *  with fresh Requests is its own cost. */
const PROJECT_HOST_HOPS_HEADER = "x-itx-expression-hops";
const PROJECT_HOST_MAX_HOPS = 4;

/** WHO a project host's request is, as the lane into a context reads it: `principal` is the
 *  verified stamp the context runs the call under (null: nobody); `platformBearer` says the
 *  `Authorization: Bearer` was the platform's own credential, which an app never sees. */
type ProjectHostIdentity = { principal: Principal | null; platformBearer: boolean };

/** The credential kinds `authenticate` takes (session.ts), read off a request and tried in order —
 *  the bearer as a project token, as the admin secret, as THIS project's secret; then the host
 *  cookie as a project token — the first that verifies FOR THIS PROJECT wins (session.ts
 *  `verifyCredentials`, the one verifier). The control plane's session cookie is no candidate: it is
 *  `/api`'s alone (`from-server-cookie`, same origin only) — on a project host a cross-site
 *  navigation would carry it with no Origin to check. A credential of another project is nobody
 *  here: it stamps nothing and, as an app's own bearer scheme does, passes through. */
async function projectHostIdentityOf(
  projectId: string,
  input: Pick<SessionInput, "request" | "directory" | "appConfig" | "secretsKv">,
): Promise<ProjectHostIdentity> {
  const { headers } = input.request;
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  const hostCookieToken = projectSessionCookieOf(headers.get("cookie"));
  const candidates: { credentials: SessionCredentials; platformBearer: boolean }[] = [
    ...(bearer === undefined
      ? []
      : [
          { credentials: { type: "project-token" as const, token: bearer }, platformBearer: true },
          { credentials: { type: "admin-secret" as const, secret: bearer }, platformBearer: true },
          {
            credentials: { type: "project-secret" as const, project: projectId, secret: bearer },
            platformBearer: true,
          },
        ]),
    ...(hostCookieToken === null
      ? []
      : [
          {
            credentials: { type: "project-token" as const, token: hostCookieToken },
            platformBearer: false,
          },
        ]),
  ];
  for (const { credentials, platformBearer } of candidates) {
    const sessionPrincipal = await verifyCredentials(credentials, input);
    if (
      !sessionPrincipal ||
      (sessionPrincipal.projectId !== undefined && sessionPrincipal.projectId !== projectId)
    )
      continue;
    const { projectId: _boundProjectId, ...principal } = sessionPrincipal;
    return { principal, platformBearer };
  }
  return { principal: null, platformBearer: false };
}

/** The Request a project host hands the context DO — the same Request, its URL, method, body and a
 *  WebSocket upgrade intact, with the headers made the platform's: every inbound `x-itx-*` gone (a
 *  pager or fetch-upgrade header from outside would enter the DO's internal protocol), the cookie
 *  header replaced by `appCookies` (null ⇒ none — what the capability may see), a platform bearer
 *  (this project's token, the admin secret, this project's secret) removed (an app's own bearer
 *  scheme passes through untouched), then the expression the host names — `itx.apps.<app>`, or the
 *  config worker `itx.worker` for a host with no app label (its `fetch` routes by hostname,
 *  sdk/index.ts `ConfigWorker`) — the hop count and the principal's stamp. The app label the app
 *  sees (`x-iterate-app`) is not written here: the DO's fetch lane derives it from the expression,
 *  the one door every fetch-lane Request passes (iterate-context-durable-object.ts). */
function projectHostRequestTo(
  request: Request,
  lane: {
    app: string | null;
    hops: number;
    appCookies: string | null;
    identity: ProjectHostIdentity;
  },
): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-itx-")) headers.delete(name);
  if (lane.appCookies) headers.set("cookie", lane.appCookies);
  else headers.delete("cookie");
  if (lane.identity.platformBearer) headers.delete("authorization");
  headers.set(
    ITX_EXPRESSION_FETCH_HEADER,
    lane.app === null ? "itx.worker" : `itx.apps.${lane.app}`,
  );
  headers.set(PROJECT_HOST_HOPS_HEADER, String(lane.hops));
  if (lane.identity.principal)
    headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(lane.identity.principal));
  return new Request(request, { headers });
}

// The native workerd brands the step walk threads unawaited (expression.ts `PIPELINED_RPC_BRANDS` —
// it cannot import cloudflare:workers itself). A call step yields an RpcPromise; a PROPERTY step on
// one yields an RpcProperty — both pipeline, so both register. The cast bridges a workers-types gap:
// the runtime exports both (verified by probe) but the .d.ts doesn't.
const { RpcPromise: NativeRpcPromise, RpcProperty: NativeRpcProperty } =
  cloudflareWorkers as unknown as Record<"RpcPromise" | "RpcProperty", abstract new () => unknown>;
registerPipelinedRpcBrand(NativeRpcPromise);
registerPipelinedRpcBrand(NativeRpcProperty);
// capnweb's own promises pipeline the same way, and the library's `itx.connectToCapnweb` puts them
// in the walk (library.ts): a remote chain `.a().b(x)` must stay unawaited between steps or
// a one-shot batch session dies after its first message. A capnweb RpcStub is not a promise; it
// registers so a stub-valued step is never awaited either (awaiting one is a no-op anyway).
registerPipelinedRpcBrand(CapnwebRpcPromise as unknown as abstract new () => unknown);
registerPipelinedRpcBrand(CapnwebRpcStub as unknown as abstract new () => unknown);

export { IterateContextDurableObject };
export { ItxEntrypoint } from "./iterate-context.ts";

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // THE HOP COUNT — what the app forwards: a request carrying the count it was handed re-enters
    // here with it, each pass adds one, a few is a loop; a fresh Request carries none and starts at
    // zero. The edge writes digits; anything else (an app spelling "NaN" to defeat the budget —
    // `NaN > max` is never true) is over budget by definition.
    const hopsHeader = request.headers.get(PROJECT_HOST_HOPS_HEADER) ?? "0";
    const hops = /^\d{1,3}$/.test(hopsHeader) ? Number(hopsHeader) + 1 : Infinity;
    if (hops > PROJECT_HOST_MAX_HOPS)
      return new Response(
        `the request re-entered itself ${Number.isFinite(hops) ? hops : `"${hopsHeader}"`} times (an app fetching its own host)\n`,
        { status: 508 },
      );

    // PROJECT-HOST INGRESS (the project host section below): a request on a project host IS the app
    // it names — or, with no app label, the project's config worker — the Request riding into the
    // DO's fetch lane with its URL, the app's own cookies and a WebSocket upgrade intact. Everything
    // on a project host is the app's; the platform's own doors live on the worker's hostname.
    const appConfig = appConfigOf(env);
    const { projectHostnameBase, projectTokenSecret, environmentName, deployId } = appConfig;
    /** What every session and every lane's identity is built from — ONE object per request. */
    const sessionInput: SessionInput = {
      contextNamespace: env.ITERATE_CONTEXT,
      waitUntil: (promise) => ctx.waitUntil(promise),
      directory: directory(env.DB),
      request,
      appConfig,
      secretsKv: env.SECRETS_KV,
    };
    const projectHost = projectHostOf(url.hostname, projectHostnameBase);
    if (projectHost) {
      // ADMISSION, before any Durable Object is dialled: a context is created on first touch, so a
      // hostname whose project the in-process directory does not know must never reach one — else
      // any label under the wildcard would mint durable storage from the public internet. One
      // directory read — the row resolves the host's label (an id or a slug) to the project's id;
      // an unknown project is 421.
      const project = await sessionInput.directory.getProject(projectHost.project);
      if (!project)
        return new Response(
          `421: no project ${JSON.stringify(projectHost.project)} is served here\n`,
          { status: 421 },
        );
      const projectId = project.id;
      const sessionResponse = await projectSessionResponse(request, projectId, projectTokenSecret);
      if (sessionResponse) return sessionResponse;
      // the visitor's own cookies reach the app; the platform's cookie and bearer never do
      return env.ITERATE_CONTEXT.getByName(
        DurableObjectNameCodec.stringify({ projectId, path: "/" }),
      ).fetch(
        projectHostRequestTo(request, {
          app: projectHost.app,
          hops,
          appCookies: withoutProjectSessionCookie(request.headers.get("cookie")) || null,
          identity: await projectHostIdentityOf(projectId, sessionInput),
        }),
      );
    }
    // Under the base there are project hosts and nothing else: a hostname there that fails the
    // grammar (`site--prj_1`, `a.b.c`, `--x`) names no project host and must not fall through to the
    // control plane — a working platform origin on a name the platform never chose. 421.
    if (hostnameLabelsUnderBase(url.hostname, projectHostnameBase))
      return new Response(
        `421: ${url.hostname} is not a project host under ${projectHostnameBase}\n`,
        { status: 421 },
      );

    // `<deployId> <environmentName>`: Cloudflare's version id of this deploy — the stamp a smoke
    // waits for (`wrangler deploy` prints it) — and which deployment this is (the app config section below).
    if (url.pathname === "/version") return new Response(`${deployId} ${environmentName}\n`);

    // THE ONE capnweb ENTRYPOINT (the hard rule): capnweb terminates HERE, in the stateless worker;
    // the DO is reached only over Workers RPC. WHO dials is `authenticate(credentials)`'s answer
    // (session.ts): the control plane's session cookie on THIS request, a project token, a project
    // secret, or the admin secret.
    if (url.pathname === "/api") {
      // newWorkersRpcResponse serves BOTH a WebSocket upgrade AND a one-shot HTTP batch —
      // a CLI script or cron does one POST, no socket handshake. (Batch sessions cannot hold
      // live capabilities: a live provide needs the relay to outlive the response —
      // the relay's lend call simply fails there, which is the honest error.)
      return newWorkersRpcResponse(request, new UnauthenticatedSession(sessionInput));
    }

    // THE STATIC ASSETS — the console's client bundle (dist/client, `vite build`) and the hosted /demo
    // page (public/demo.html, build-sdk.mjs) — are the PLATFORM HOST's. Every request runs
    // worker-first (wrangler.jsonc `run_worker_first: true` — the patterns are paths, never hostnames,
    // so "every host but a project host" is spelled by asking the binding HERE, after the project
    // hosts and the platform's own doors): no asset ever answers on a project host, and a miss falls
    // through to the control plane — the console's SSR. Absent in the workers lane.
    if ((request.method === "GET" || request.method === "HEAD") && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    // Everything else on the platform host is the CONTROL PLANE, in-process (src/control-plane.ts
    // lists its doors: the OAuth AS, /mcp, the console). One worker, one front door.
    return controlPlane.fetch(request, env, ctx);
  },
};

// ── app config ── THE WORKER'S CONFIGURATION: one typed object per isolate, read from the `APP_CONFIG_*`
// wrangler vars plus the platform-supplied deploy identity (the version-metadata binding). Loud on
// anything malformed, at first use — never a silent default.
//
// Configuration is what differs between deployments of the SAME code: the vars below and the deploy
// id. A constant (timeouts, budgets, key conventions, the loaded-worker compatibility flags) is a
// property of the code and lives beside its consumer. A var nothing reads does not exist; an
// `APP_CONFIG_*` var this file does not name is refused, so a typo can never configure nothing silently.

const APP_CONFIG_VARS = [
  "APP_CONFIG_ENVIRONMENT_NAME",
  "APP_CONFIG_PROJECT_HOSTNAME_BASE",
  "APP_CONFIG_PROJECT_TOKEN_SECRET",
  "APP_CONFIG_ARTIFACTS_ACCOUNT_ID",
  "APP_CONFIG_ARTIFACTS_NAMESPACE",
  "APP_CONFIG_SESSION_SECRET",
  "APP_CONFIG_ADMIN_API_SECRET",
] as const;
/** One of the `APP_CONFIG_*` vars — the only names `parseAppConfig` reads. */
type AppConfigVarName = (typeof APP_CONFIG_VARS)[number];

/** THE WORKER'S CONFIGURATION: what differs between deployments of the same code, parsed once per
 *  isolate (`appConfigOf`) from the `APP_CONFIG_*` vars and the deploy identity. */
export interface AppConfig {
  /** Which deployment this is, as a word a human reads at `/version`: "poc" (the deployment), "test"
   *  (the workers lane), "e2e" (the e2e lane). Required. */
  readonly environmentName: string;
  /** The base every project host hangs under — `<app>--<project>.<base>`, `<app>.<project>.<base>`,
   *  `<project>.<base>` (the project host section); blank ⇒ no project-host ingress. */
  readonly projectHostnameBase: string;
  /** The HMAC secret project tokens are signed with (principal.ts) — a wrangler SECRET on a deployment,
   *  a var in the test lanes. Required: a blank secret signs no token (`mintToken`, the console's
   *  project links) and verifies none. */
  readonly projectTokenSecret: string;
  /** The Cloudflare account + Artifacts namespace `itx.repos` builds git remotes from
   *  (`https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`); blank where no
   *  Artifacts binding exists (the workers lane). */
  readonly artifactsAccountId: string;
  readonly artifactsNamespace: string;
  /** The HMAC secret the control plane's session cookie is signed with (control-plane.ts) — a
   *  wrangler SECRET on a deployment, a var in the test lanes. Required: a blank secret signs no
   *  cookie and verifies none. */
  readonly sessionSecret: string;
  /** The deployment's admin secret — `authenticate({ type: "admin-secret" })` (session.ts) and the
   *  project host's admin bearer (`projectHostIdentityOf`): every project. A wrangler SECRET on a deployment, a var
   *  in the test lanes. Required: a blank secret would match nothing. */
  readonly adminApiSecret: string;
  /** Cloudflare's version id of the running deployment (`CF_VERSION_METADATA.id`; local workerd mints
   *  one too); "unversioned" where the binding is absent or blank. In every loader cacheKey and at
   *  `/version`. */
  readonly deployId: string;
}

/** The slice of `env` the configuration reads: the version-metadata binding and the vars, each an
 *  optional string. The worker's `Env` extends this. */
export type AppConfigEnv = { CF_VERSION_METADATA?: { id: string } } & {
  [Name in AppConfigVarName]?: string;
};

/** Parse the configuration out of `vars` (a worker env, or any record — only `APP_CONFIG_*` keys are
 *  read). Pure; the door every test goes through. */
export function parseAppConfig(vars: object, deployId = "unversioned"): AppConfig {
  const record = vars as Record<string, unknown>;
  for (const name of Object.keys(record))
    if (name.startsWith("APP_CONFIG_") && !(APP_CONFIG_VARS as readonly string[]).includes(name))
      throw new Error(
        `${name}: unknown configuration variable (known: ${APP_CONFIG_VARS.join(", ")})`,
      );
  const read = (name: AppConfigVarName): string => {
    const raw = record[name];
    if (raw !== undefined && typeof raw !== "string")
      throw new Error(`${name}: expected a string variable, got ${JSON.stringify(raw)}`);
    return (raw ?? "").trim();
  };
  const environmentName = read("APP_CONFIG_ENVIRONMENT_NAME");
  if (!environmentName)
    throw new Error("APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank");
  const projectTokenSecret = read("APP_CONFIG_PROJECT_TOKEN_SECRET");
  if (!projectTokenSecret)
    throw new Error("APP_CONFIG_PROJECT_TOKEN_SECRET: required, but unset or blank");
  const sessionSecret = read("APP_CONFIG_SESSION_SECRET");
  if (!sessionSecret) throw new Error("APP_CONFIG_SESSION_SECRET: required, but unset or blank");
  const adminApiSecret = read("APP_CONFIG_ADMIN_API_SECRET");
  if (!adminApiSecret) throw new Error("APP_CONFIG_ADMIN_API_SECRET: required, but unset or blank");
  return {
    environmentName,
    projectHostnameBase: read("APP_CONFIG_PROJECT_HOSTNAME_BASE"),
    projectTokenSecret,
    artifactsAccountId: read("APP_CONFIG_ARTIFACTS_ACCOUNT_ID"),
    artifactsNamespace: read("APP_CONFIG_ARTIFACTS_NAMESPACE"),
    sessionSecret,
    adminApiSecret,
    deployId,
  };
}

const appConfigByEnv = new WeakMap<object, AppConfig>();

/** The configuration of the isolate `env` belongs to — parsed on first use, then the same object every
 *  time (a WeakMap on the env object: a worker's `env` and a DO's `this.env` are stable for the
 *  isolate's life). A malformed variable throws HERE, on the first request or the first DO
 *  construction, naming the variable. */
export function appConfigOf(env: AppConfigEnv): AppConfig {
  let appConfig = appConfigByEnv.get(env);
  if (!appConfig) {
    appConfig = parseAppConfig(env, env.CF_VERSION_METADATA?.id?.trim() || "unversioned");
    appConfigByEnv.set(env, appConfig);
  }
  return appConfig;
}

// ── project host ── PROJECT-HOST INGRESS, the pure half: which project and which app a hostname names
// ("a label is the address" — apps/os's host shapes). `<app>--<project>.<base>` and
// `<app>.<project>.<base>` serve `itx.apps.<app>` of the project's ROOT context; the apex
// `<project>.<base>` names no app and serves the project's config worker, `itx.worker` — its `fetch`
// routes by hostname (sdk/index.ts `ConfigWorker`; the bundled default answers 404). Every app is
// exactly one row, and the log never names a hostname: one rule row (`provide("itx.apps.site", …)`)
// serves the app on every host the project has. `<project>` is the project's id or its slug — one
// DNS label here, the directory slugifies an id — which the in-process directory resolves and admits
// before the Request rides into the DO's fetch lane (`projectHostRequestTo`). A CUSTOM HOSTNAME
// (`acme.com`, `<app>.acme.com`) is a directory lookup by hostname, not built: a later build adds the
// row and the resolver. The one door the platform itself answers on a project host — the session
// cookie's — is here too (`projectSessionResponse`), beside the cookie it sets.

/** The cookie a project host holds a project token in (a browser's lane; `/.itx/session` sets it).
 *  `__Host-`: a browser accepts it only as set here — `Secure`, `Path=/`, no `Domain` — so it is
 *  this host's alone and no sibling host under the base can set or shadow it. */
const PROJECT_SESSION_COOKIE = "__Host-itx-project-session";
/** The one path the platform answers on a project host — `?token=<projectToken>&next=<path>` sets
 *  the cookie and redirects to `next`; `POST ?logout` clears it. Everything else is the app's. */
const PROJECT_SESSION_PATH = "/.itx/session";

/** The project token a request's cookie carries, or null. */
export function projectSessionCookieOf(cookieHeader: string | null): string | null {
  return cookieValueOf(cookieHeader, PROJECT_SESSION_COOKIE) || null;
}

/** The cookie header with the platform's own cookie removed — what an app (loaded code) may see:
 *  the token in it would let the app act as the visitor (`authenticate({ type: "project-token" })`). */
export function withoutProjectSessionCookie(cookieHeader: string | null): string {
  return (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${PROJECT_SESSION_COOKIE}=`))
    .join("; ");
}

/** `next` as a path on `origin`, else "/" — a redirect never leaves the host: `//evil.example`,
 *  `/\evil.example` and an absolute URL all resolve to a foreign origin and fall back to "/". The
 *  control plane's login redirect uses it too (control-plane.ts). */
export function sameOriginPath(next: string, origin: string): string {
  try {
    const url = new URL(next, origin);
    return url.origin === origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}

/** The `Set-Cookie` value that stores `token` for `maxAgeSeconds` (≤ 0 clears it): host-scoped
 *  (`__Host-`, `Path=/`, no `Domain`), HttpOnly, Secure (a browser exempts localhost), SameSite=Lax
 *  so a top-level navigation from the control plane's login carries it. */
const projectSessionSetCookie = (token: string, maxAgeSeconds: number): string =>
  `${PROJECT_SESSION_COOKIE}=${maxAgeSeconds > 0 ? token : ""}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;

/** THE SESSION DOOR on a project host (PARTIAL: null when the request is not on its path): a
 *  project token (principal.ts) for `projectId` — `?token=` — becomes the host-scoped cookie and the
 *  browser goes on to `next` (303); `POST ?logout` clears the cookie — a POST like the console's
 *  `/logout` (a GET cannot end a session: 405) and, like every console POST, refused from a foreign
 *  origin (403); a token that does not verify for this project is a 401. */
export async function projectSessionResponse(
  request: Pick<Request, "url" | "method" | "headers">,
  projectId: string,
  projectTokenSecret: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PROJECT_SESSION_PATH) return null;
  const location = sameOriginPath(url.searchParams.get("next") ?? "/", url.origin);
  if (url.searchParams.has("logout")) {
    if (request.method !== "POST")
      return new Response("405: log out with a POST\n", {
        status: 405,
        headers: { allow: "POST" },
      });
    if (!isSameOriginBrowserRequest(request))
      return new Response("403: a cross-site request cannot end this session\n", { status: 403 });
    return new Response(null, {
      status: 303,
      headers: { location, "set-cookie": projectSessionSetCookie("", 0) },
    });
  }
  const token = url.searchParams.get("token") ?? "";
  const claims = await verifyProjectToken(token, projectTokenSecret);
  if (!claims || claims.projectId !== projectId)
    return new Response("the project token did not verify for this project\n", { status: 401 });
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "set-cookie": projectSessionSetCookie(token, (claims.expiresAt - Date.now()) / 1000),
    },
  });
}

/** A DNS label: lowercase letters and digits, single hyphens inside. */
const DNS_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An app label: a DNS label that is also an itx identifier (it becomes a step, `itx.apps.<label>`). */
const APP_LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The labels `hostname` has under `base` — `site--p.iterate.app` ⇒ `["site--p"]` — lowercased, a
 *  trailing dot (a fully-qualified Host, `site--p.base.`) dropped; null when the hostname is not
 *  under `base` at all, and a blank `base` has nothing under it. */
function hostnameLabelsUnderBase(hostname: string, base: string): string[] | null {
  if (!base) return null;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const suffix = `.${base.toLowerCase()}`;
  return host.endsWith(suffix) ? host.slice(0, -suffix.length).split(".") : null;
}

/** The app + project a host names, or null when `hostname` is not a project host under `base` (a
 *  blank `base` ⇒ no project-host ingress at all). `<app>--<project>.<base>` and
 *  `<app>.<project>.<base>` name the app `<app>`; the apex `<project>.<base>` names none (`app:
 *  null` — the config worker answers). `project` is the label as written, an id or a slug: whether
 *  the project EXISTS, and which id it is, is the directory's answer (the edge above). Pure. */
export function projectHostOf(
  hostname: string,
  base: string,
): { app: string | null; project: ProjectIdOrSlug } | null {
  const labels = hostnameLabelsUnderBase(hostname, base);
  if (labels === null || labels.length > 2) return null; // deeper than `<app>.<project>` is not a project host
  const [first, second] = labels as [string, string?];
  const separator = first.startsWith("xn--") ? -1 : first.indexOf("--"); // `xn--…` is an IDN label (punycode), never `<app>--<project>`
  const [app, project] =
    second !== undefined
      ? [first, second] // `<app>.<project>`
      : separator === -1
        ? [null, first] // the apex, `<project>`
        : [first.slice(0, separator), first.slice(separator + 2)]; // `<app>--<project>`
  if (!DNS_LABEL.test(project) || (app !== null && !APP_LABEL.test(app))) return null;
  return { app, project };
}
