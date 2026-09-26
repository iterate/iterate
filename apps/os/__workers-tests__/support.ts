// __workers-tests__/support.ts — what every file in the Workers suite (the vitest project that runs
// INSIDE workerd, next to the worker) shares: the context DO stub by ctx name, its log and a facet's
// snapshot read through it, the control plane's database, a capnweb session over the worker's /api
// (disposed at teardown — importing this module registers the afterAll), a live value to lend
// (`Echo`, tagged per instance), the production pins' release on demand, the alarm a context owes,
// the one poll-until, a signed-in member with their browser cookie, and the pet shop's integration
// fakes. The named loaded sources (COUNTER_SOURCE and the facet rows') are ./sources.ts; other
// rows inline their own.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, vi } from "vitest";
import type { StreamPage } from "iterate/api";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import { ControlPlaneDatabase } from "../src/control-plane/catalog.ts";
import { projectsByHostnames } from "../src/control-plane/db/queries/.generated/hostnames.sql.ts";
import { accessibleOrganizations } from "../src/control-plane/db/queries/.generated/organizations.sql.ts";
import { projectsByRef } from "../src/control-plane/db/queries/.generated/projects.sql.ts";
import { ControlPlane } from "../src/control-plane/edge.ts";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { memoryPetshop } from "../../dummy-petshop/src/memory-state.ts";

/** This suite's platform origin (wrangler.test.jsonc `APP_CONFIG_URLS__OS`). */
export const ORIGIN = "https://control.test";

/** The context DO for a ctx name (a project id or a full codec name), through the ITERATE_CONTEXT
 *  binding — the raw Workers-RPC stub, which is this suite's whole point: the DO's verbs with no
 *  edge reducing the returns away, plus runInDurableObject over the same instance. */
export const stub = (ctx: string) =>
  env.ITERATE_CONTEXT.getByName(DurableObjectNameCodec.parse(ctx).name);

/** A context's durable log, its first 500 events: `itx.readEvents` invoked on the context's DO with
 *  no caller. `includeEphemeral` merges in the ephemerals the running incarnation still holds, where
 *  the alarm passes' traces are. */
export async function readLog(ctx: string, options?: { includeEphemeral: true }) {
  const page = (await stub(ctx).invoke([
    "itx",
    ["readEvents", 0, 500, ...(options ? [options] : [])],
  ])) as StreamPage;
  return page.events;
}

/** Facet `facet`'s folded state and the offset it reduced through, from the context's DO:
 *  `itx.facets.get(facet).snapshot()` invoked with no caller. */
export async function snapshot<State>(ctx: string, facet: string) {
  return (await stub(ctx).invoke(["itx", "facets", ["get", facet], ["snapshot"]])) as {
    offset: number;
    state: State;
  };
}

/** One client's rpc stub, lent under its key: the per-instance tag (`echo-<i>:<s>`) proves no
 *  crosstalk. Provided as `itx.provide(rpcStubKey, new Echo(i))`, so
 *  the key is also the dotted match a caller spells. */
export class Echo extends RpcTarget {
  readonly #i: number;
  constructor(i: number) {
    super();
    this.#i = i;
  }
  echo(s: string): string {
    return `echo-${this.#i}:${s}`;
  }
}

/** THE CATALOG, the control plane's database over this file's D1 (src/control-plane/catalog.ts): a
 *  test calls its verbs directly (`catalog().project(ref)`) with no edge, memo or session between. */
export const catalog = () => new ControlPlaneDatabase(env.DB);

/** The control plane as the edge holds it (src/control-plane/edge.ts): the catalog's rows and the
 *  isolate's memos. */
export const controlPlane = () => new ControlPlane(env);

/** THE CATALOG READS a project host's admission and a person's access make, each told by the SQL
 *  it sends D1 (src/control-plane/db/queries), up to its first parameter. */
const CATALOG_READS = {
  project: projectsByRef.sql,
  projectByHostname: projectsByHostnames.sql,
  accessibleTo: accessibleOrganizations.sql,
};
export type CatalogRead = keyof typeof CATALOG_READS;

/** Every catalog read sent to this file's D1 until the test finishes — the worker's, whose binding
 *  is this isolate's `env.DB` too — each spy called with the value its first parameter binds (a
 *  ref, the first hostname asked, a user id). With `fail`, those `reads` answer what `fail.with`
 *  makes of the real call, a single statement's and a batch's alike. */
export function interceptCatalogReads(fail?: {
  reads: readonly CatalogRead[];
  with: <T>(answer: () => Promise<T>) => Promise<T>;
}) {
  const reads = { project: vi.fn(), projectByHostname: vi.fn(), accessibleTo: vi.fn() };
  const readOf = (sql: string) =>
    (Object.keys(CATALOG_READS) as CatalogRead[]).find((read) =>
      sql.startsWith(CATALOG_READS[read].slice(0, CATALOG_READS[read].indexOf("?"))),
    );
  const failing = new WeakSet<D1PreparedStatement>();
  const prepare = env.DB.prepare.bind(env.DB);
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const read = readOf(sql);
    if (!read) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      reads[read](args[0]);
      const bound = bind(...args);
      if (fail?.reads.includes(read)) {
        failing.add(bound);
        const all = bound.all.bind(bound);
        bound.all = (() => fail.with(all)) as typeof bound.all;
      }
      return bound;
    };
    return statement;
  });
  vi.spyOn(env.DB, "batch").mockImplementation((statements) =>
    statements.some((statement) => failing.has(statement))
      ? fail!.with(() => batch(statements))
      : batch(statements),
  );
  return reads;
}

/** This suite's admin bearer (wrangler.test.jsonc `APP_CONFIG_SECRETS__ADMIN_BEARER`). */
const adminApiSecret = (): string => env.APP_CONFIG_SECRETS__ADMIN_BEARER!;
/** THE suite's credentials (src/session.ts): the admin bearer — every project, `{ actor: "admin" }`. */
export const adminCredentials = () => ({ type: "admin-secret" as const, secret: adminApiSecret() });
/** This suite's sign-in password (wrangler.test.jsonc `APP_CONFIG_LOGIN__PASSWORD`) — what a browser
 *  session is minted with through `POST /login` (email + password). */
export const loginPassword = (): string => env.APP_CONFIG_LOGIN__PASSWORD!;

/** A site that answers with what the platform handed it: the principal stamp, the bearer, the
 *  cookies and the trusted routing slug — published as a project's config worker
 *  (`publishConfigWorker`) and fetched on a project host. */
export const SRC_ECHO_APP = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      routingSlug: request.headers.get("x-iterate-routing-slug"),
    });
  }
}`,
};

// capnweb sessions live for the whole file; disposed at teardown (sessions left open turn into
// unhandled-rejection noise).
const sessions: unknown[] = [];
/** Open a capnweb session to the worker over a BARE WebSocket upgrade on `exports.default.fetch` (`/api` with no
 *  credential: the socket authenticates in-band) — newWebSocketRpcSession accepts the existing
 *  (accepted) socket per its typings. */
// The RETURN is deliberately `any`: this is the shared LENDING entry point — callers reach through it to
// `.provide(key, new Echo(i))`, `.provide("itx.site", new LiveSite())` and other live RpcTargets,
// which capnweb's typed `provide` param (`ClientRpcStub`, a `dup()`-bearing shape) rejects for a raw
// RpcTarget instance. A READ caller that wants the real surface names it locally
// (`const root: RpcStub<IterateRpcTarget> = await openSession()`), the way userSession does.
export async function openSession(): Promise<any> {
  const res = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  });
  if (!res.webSocket) throw new Error(`expected a 101 with a WebSocket, got ${res.status}`);
  res.webSocket.accept();
  const session = newWebSocketRpcSession(res.webSocket as unknown as WebSocket);
  sessions.push(session);
  return session as any;
}
afterAll(async () => {
  if (sessions.length === 0) return;
  // Let any fire-and-forget page/alarm cleanup drain before the suite's RPC bridge is torn down —
  // otherwise a still-pending resolve surfaces as a (harmless) EnvironmentTeardownError.
  await new Promise((r) => setTimeout(r, 50));
  for (const s of sessions) {
    try {
      (s as Partial<Disposable>)[Symbol.dispose]?.();
    } catch {
      /* already broken */
    }
  }
});

/** A bare `/api` socket authenticated in-band with the admin secret — every project, or `as` the
 *  person `email` names (src/session.ts): how a fixture makes a user, or acts as one before they
 *  have signed in. Its transport joins `sessions`, which the calling file disposes. */
export async function adminSession(sessions: Disposable[], email?: string) {
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(transport);
  return transport.authenticate({ ...adminCredentials(), ...(email && { as: { email } }) });
}

/** `thunk` is REFUSED with `code`: an entity's refusal crosses its own log as
 *  `request-failed { code }` and is rethrown coded at the edge; the edge's own refusal is coded
 *  before anything lands. A broken pipeline or a typo never passes as a refusal. */
export async function refused(
  thunk: () => Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<void> {
  let refusal: unknown;
  try {
    await thunk();
  } catch (error) {
    refusal = error;
  }
  expect(refusal, `expected a ${code} refusal, but it was allowed`).toBeDefined();
  expect((refusal as { code?: string }).code).toBe(code);
  if (message) expect((refusal as Error).message).toMatch(message);
}

/** A person signed in through the login form (email + the deployment's password), then on `/api`
 *  with the browser's session cookie: an ordinary user session — no admin credential anywhere. */
export async function signedInSession(email: string): Promise<any> {
  return (await signedInMember(email)).session;
}

/** `signedInSession`'s person with the browser's session cookie too, for the platform's own pages
 *  and callbacks. The issuer fetches its own client metadata while it signs someone in; `fetch`
 *  reaches this worker for that one request (as control-plane.test.ts does), the network being out
 *  of reach here. */
export async function signedInMember(email: string): Promise<{ session: any; cookie: string }> {
  const issuerFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => exports.default.fetch(new Request(input, init)));
  const login = await exports.default.fetch(`${ORIGIN}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: ORIGIN },
    body: new URLSearchParams({ email, password: loginPassword(), next: "/" }),
  });
  issuerFetch.mockRestore();
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: cookie },
  });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(transport);
  return { session: await transport.authenticate({ type: "from-server-cookie" }), cookie };
}

/** `fetch` reaches this worker for the rest of the test: the issuer fetches its own client metadata
 *  while it signs someone in, and the network is out of reach here. Provider metadata, PKCE,
 *  exchange, storage and API are real. */
export function fetchReachesThisWorker() {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    exports.default.fetch(new Request(input, init)),
  );
}

/** A project `slug` made by a member of its own (`<slug>@example.test`): their itx on it, its id,
 *  their `/api` session and their browser cookie. */
export async function projectWithMember(slug: string) {
  const { session, cookie } = await signedInMember(`${slug}@example.test`);
  const itx = await session.projects.create({ project: slug });
  const { projectId } = (await itx.whoami()) as { projectId: string };
  return { itx, projectId, session, cookie };
}

/** The hosts the pet shop's Slack, Google, Cloudflare and GitHub fakes answer on in this suite
 *  (APP_CONFIG `integrations`, wrangler.test.jsonc and vitest.config.ts). */
const PETSHOP_HOSTS = ["slack.test", "google.test", "cloudflare.test", "github.test"];

/** The pet shop's Slack, Google, Cloudflare and GitHub fakes over in-memory state, answering this isolate's
 *  `fetch` to their hosts until the test finishes, and the issuer's own requests to this worker;
 *  every other request goes through. `requests`
 *  holds each request they were sent, oldest first. Sign everyone in first: `signedInMember` restores
 *  `fetch`. */
export function petshopFakes() {
  const petshop = memoryPetshop();
  const requests: { method: string; url: string; headers: Record<string, string>; body: string }[] =
    [];
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    // the issuer fetching its own client metadata while it signs someone in (`signedInMember`)
    if (new URL(request.url).origin === ORIGIN) return exports.default.fetch(request);
    if (!PETSHOP_HOSTS.includes(new URL(request.url).hostname)) return through(request);
    // read here: a body belongs to the Durable Object that sent it
    const { method, url, headers } = request;
    requests.push({
      method,
      url,
      headers: Object.fromEntries(headers),
      body: await request.clone().text(),
    });
    return (await petshop.handle(request)) ?? new Response("Not Found", { status: 404 });
  });
  return { ...petshop, requests };
}

/** A human's browser from a provider's consent page back through the platform: each hop at a fake
 *  answered by the pet shop, each at the platform's `/api/integrations/` sent with `cookie`. Answers
 *  the first response that goes anywhere else — the platform's redirect to `next`, or its refusal. */
export async function followConsent(
  petshop: ReturnType<typeof petshopFakes>,
  url: string,
  cookie: string,
): Promise<Response> {
  for (let hop = 0; hop < 8; hop++) {
    const request = new Request(url, { headers: { cookie }, redirect: "manual" });
    const response = PETSHOP_HOSTS.includes(new URL(url).hostname)
      ? ((await petshop.handle(request)) ?? new Response("Not Found", { status: 404 }))
      : await exports.default.fetch(request);
    const location = response.headers.get("location");
    const next = location ? new URL(location, url) : null;
    const onward =
      next &&
      (PETSHOP_HOSTS.includes(next.hostname) ||
        (next.origin === ORIGIN && next.pathname.startsWith("/api/integrations/")));
    if (!onward) return response;
    url = next.href;
  }
  throw new Error(`followConsent: still redirecting at ${url}`);
}

/** The pins' RELEASE, run directly, plus every live facet aborted: every borrowed stub returned,
 *  every library connection closed — making the DO dormant, which is evictDurableObject's de-facto
 *  precondition here: workerd keeps a DO with a materialized facet or a borrowed stub
 *  non-hibernatable (workerd#6800), and evicting such a DO times out after 30s on "still has active
 *  references". You must release BEFORE you can evict. Run directly: in production the pins'
 *  30 s timer releases them, and a facet does not keep the actor resident on the edge (it runs on
 *  after it; the next incarnation's birth resets it when loaded and unclaimed — FacetHost
 *  `startFacetsTheLastIncarnationRan`); a test that wants the alarm PASS itself fakes Date
 *  and calls `runDurableObjectAlarm`. */
export async function releasePins(ctx: string): Promise<void> {
  await runInDurableObject(stub(ctx), (instance) => {
    (instance as IterateContextDurableObject).releasePins();
  });
}

/** THE ALARM A CONTEXT OWES, from its physical alarm: null when there is none or it is only the
 *  running incarnation's in-memory deadline (`inMemory`, the DO's `inMemoryAlarmDeadlines()`: the
 *  unclaimed-facet sweep's, armed once a loaded facet is materialized) — no obligation. */
export const owedAlarm = (alarm: number | null, inMemory: (number | null)[] = []): number | null =>
  alarm !== null && !inMemory.includes(alarm) ? alarm : null;

/** `owedAlarm` of a context, read inside its DO: the physical alarm beside the running incarnation's
 *  in-memory deadlines. */
export const owedAlarmOf = (s: ReturnType<typeof stub>): Promise<number | null> =>
  runInDurableObject(s, async (instance, state) =>
    owedAlarm(
      await state.storage.getAlarm(),
      (instance as IterateContextDurableObject).inMemoryAlarmDeadlines(),
    ),
  );

/** Poll `fn` until it returns a defined, non-false value (bounded). Physical facts arrive a beat
 *  after the RPC that triggered them: a pager leaves the census when its CLOSE lands at the DO, a
 *  handle's rule un-set rides the edge's waitUntil, a page reaches a pager over its socket. */
export async function until<T>(
  label: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`until(${label}): timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Cloudflare's custom-hostname API on the SaaS zone (wrangler.test.jsonc `saas.test`), faked in
 *  this isolate's `fetch`; every other request goes through. `active` are custom hostnames the zone
 *  already holds, validated (what an erase leaves behind: it never deletes them); a new one is
 *  pending. `writes` records each POST and DELETE. */
export function fakeCloudflareCustomHostnames({ active = [] }: { active?: string[] } = {}) {
  const hostnames: string[] = [...active];
  const writes: string[] = [];
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return through(request);
    const ok = (result: unknown) => Response.json({ success: true, result });
    const entry = (hostname: string) =>
      active.includes(hostname)
        ? {
            id: `ch-${hostname}`,
            hostname,
            status: "active",
            ssl: { status: "active" },
          }
        : { id: `ch-${hostname}`, hostname, status: "pending" };
    if (request.method === "POST" || request.method === "DELETE")
      writes.push(`${request.method} ${url.pathname.split("/custom_hostnames")[1] || "/"}`);
    if (url.pathname.endsWith("/zones")) return ok([{ id: "zone-saas" }]);
    if (request.method === "POST") {
      const { hostname } = (await request.json()) as { hostname: string };
      hostnames.push(hostname);
      return ok(entry(hostname));
    }
    if (request.method === "DELETE") {
      hostnames.splice(hostnames.indexOf(url.pathname.split("/ch-")[1]!), 1);
      return ok({});
    }
    const asked = url.searchParams.get("hostname");
    return ok(hostnames.filter((hostname) => hostname === asked).map(entry));
  });
  return { hostnames, writes };
}
