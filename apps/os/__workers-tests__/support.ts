// __workers-tests__/support.ts — what every file in the Workers suite (the vitest project that runs
// INSIDE workerd, next to the worker) shares: the context DO stub by ctx name, the CONTROL_PLANE
// registry stub, a capnweb session over the worker's /api (disposed at teardown — importing this module
// registers the afterAll), a live value to lend (`Echo`, tagged per instance), the production pins'
// release on demand, the alarm a context owes, and the one poll-until.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, expect, onTestFinished, vi } from "vitest";
import { RESIDENCY_WATCHDOG_WINDOW_MS } from "../src/context/residency-watchdog.ts";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import { ControlPlane } from "../src/control-plane/edge.ts";
import type { IterateContextDurableObject } from "../src/iterate-context-durable-object.ts";
import type { IterateRpcTarget } from "../src/session.ts";

/** This suite's platform origin (wrangler.test.jsonc `APP_CONFIG_URLS__OS`). */
export const ORIGIN = "https://control.test";

/** The context DO for a ctx name (a project id or a full codec name), through the ITERATE_CONTEXT
 *  binding — the raw Workers-RPC stub, which is this suite's whole point: the DO's verbs with no
 *  edge reducing the returns away, plus runInDurableObject over the same instance. */
export const stub = (ctx: string) =>
  env.ITERATE_CONTEXT.getByName(DurableObjectNameCodec.parse(ctx).name);

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

/** THE REGISTRY, the `CONTROL_PLANE` singleton DO (src/control-plane/durable-object.ts): the raw
 *  Workers-RPC stub, so a test calls its methods directly (`controlPlaneStub().project(ref)`) with no
 *  edge or session between. Fresh per test. */
export const controlPlaneStub = () => env.CONTROL_PLANE.getByName("global");

/** The control plane as the edge holds it (src/control-plane/edge.ts): the catalog's rows. */
export const controlPlane = () => new ControlPlane(env.CONTROL_PLANE);

/** This suite's admin bearer (wrangler.test.jsonc `APP_CONFIG_SECRETS__ADMIN_BEARER`). */
const adminApiSecret = (): string => env.APP_CONFIG_SECRETS__ADMIN_BEARER!;
/** THE suite's credentials (src/session.ts): the admin bearer — every project, `{ actor: "admin" }`. */
export const adminCredentials = () => ({ type: "admin-secret" as const, secret: adminApiSecret() });
/** This suite's sign-in password (wrangler.test.jsonc `APP_CONFIG_LOGIN__PASSWORD`) — what a browser
 *  session is minted with through `POST /login` (email + password). */
export const loginPassword = (): string => env.APP_CONFIG_LOGIN__PASSWORD!;

/** An app that answers with what the platform handed it: the principal stamp, the bearer, the
 *  cookies and the trusted app label — provided as `itx.apps.<label>` and fetched on a project host. */
export const SRC_ECHO_APP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    return Response.json({
      principal: JSON.parse(request.headers.get("x-itx-principal") || "null"),
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      app: request.headers.get("x-iterate-app"),
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
// `.provide(key, new Echo(i))`, `.provide("itx.apps.x", new LiveSite())` and other live RpcTargets,
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
 *  with the browser's session cookie: an ordinary user session — no admin credential anywhere. The
 *  issuer fetches its own client metadata while it signs someone in; `fetch` reaches this worker for
 *  that one request (as control-plane.test.ts does), the network being out of reach here. */
export async function signedInSession(email: string): Promise<any> {
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
  const sessionCookie = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Host-itx-session="))!
    .split(";")[0]!;
  const response = await exports.default.fetch(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: sessionCookie },
  });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  sessions.push(transport);
  return transport.authenticate({ type: "from-server-cookie" });
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

/** THE ALARM A CONTEXT OWES, from its physical alarm: null when there is none or it is only one of
 *  the running incarnation's in-memory deadlines (`inMemory`, the DO's `inMemoryAlarmDeadlines()`:
 *  the residency watchdog's, src/context/residency-watchdog.ts, and the unclaimed-facet sweep's,
 *  armed once a loaded facet is materialized) — neither is an obligation. A watchdog deadline an
 *  evicted incarnation left is no obligation either: every inbound call arms it a whole window out,
 *  a row here runs for seconds and every obligation it can create is owed within minutes, so an
 *  alarm more than half a window out is the watchdog's. */
export const owedAlarm = (alarm: number | null, inMemory: (number | null)[] = []): number | null =>
  alarm !== null &&
  !inMemory.includes(alarm) &&
  alarm - Date.now() < RESIDENCY_WATCHDOG_WINDOW_MS / 2
    ? alarm
    : null;

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
 *  this isolate's `fetch`; every other request goes through. */
export function fakeCloudflareCustomHostnames() {
  const hostnames: string[] = [];
  const through = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.cloudflare.com") return through(request);
    const ok = (result: unknown) => Response.json({ success: true, result });
    const entry = (hostname: string) => ({
      id: `ch-${hostname}`,
      hostname,
      status: "pending",
      ssl: { wildcard: true },
    });
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
  onTestFinished(() => spy.mockRestore());
  return { hostnames };
}
