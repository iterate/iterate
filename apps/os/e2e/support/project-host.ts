// project-host.ts — reach the worker AS a project host (`<routingSlug>--<project>.<base>`, the one HTTP way
// into a project). Against the local worker the hosts hang under `localhost`, which macOS does not
// resolve and Node's fetch will not let a test override, so every request rides an undici Agent
// whose connector dials the worker's own address and port whatever the URL says — the URL, the
// Host header, cookies, bearers and a WebSocket upgrade all intact; against a deployed worker the
// wildcard DNS is real and the default dispatcher does. One test runs both ways.
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  request as undiciRequest,
  WebSocket as UndiciWebSocket,
} from "undici";
import { test } from "vitest";
import { projectUrlOf, type IngressRouting } from "iterate/project-ingress";
import { adminCredentials, runId, session, workerSlot, workerUrl } from "./client.ts";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const worker = (): URL => new URL(workerUrl("/"));
/** Is the worker under test the LOCAL one global-setup booted (its project hosts hang under
 *  `localhost`)? The deployed proof sets WORKER_BASE_URL to a real hostname. */
export const projectHostsAreLocal = (): boolean => LOCAL_HOSTNAMES.has(worker().hostname);
/** `test`, skipped against the local worker — for what only a real deployment can prove (Artifacts,
 *  the real AI binding, an app's fetch back into its own host). The ONE gate; never copy the regex. */
export const deployedOnly = test.skipIf(projectHostsAreLocal());
/** `deployedOnly`, and OPT-IN (`E2E_REAL_MODELS=1`): a row that pays for a real model inference.
 *  Only the daily real-model suite (os-real-model.yml) sets it. PR and main e2e runs, and the soak,
 *  answer the model with a fake instead: one AI Gateway spend cap covers the whole preview account,
 *  and on 2026-09-24 a day of soaks spent it and every PR's preview e2e went red
 *  (docs/testing.md#real-model-rows). */
export const realModelOnly = test.skipIf(
  projectHostsAreLocal() || process.env.E2E_REAL_MODELS !== "1",
);
/** `test`, skipped against a DEPLOYED worker — for rows that lend the fake git remote
 *  (support/fake-git-server.ts, listening on THIS machine's 127.0.0.1): the repo facet fetches its
 *  remote over the worker's egress, and a deployed worker cannot reach a loopback address (the
 *  platform answers 403). Rows that only touch the proxy (create, its failure) still run deployed —
 *  the fake proxy is called back over the WebSocket; the real binding's rows run in every environment, the
 *  local worker binding Artifacts too. */
export const localOnly = test.skipIf(!projectHostsAreLocal());

/** `deployedOnly` AND `subdomainsOnly`: a row only a real deployment can prove, on a host only a
 *  deployment routing by subdomain owns. A per-PR preview routes by paths on its workers.dev origin,
 *  so such a row has nowhere to dial there and skips. */
export const deployedSubdomainsOnly = test.skipIf(
  projectHostsAreLocal() || ingressRouting()?.type !== "subdomains",
);

/** How the worker under test reaches projects (src/app-config.ts `urls.ingressRouting`): subdomains
 *  under `localhost` for the local worker (worker-config.ts), the deployed worker's routing
 *  (global-setup: envs.ts, or PROJECT_INGRESS_ROUTING) otherwise. */
export function ingressRouting(): IngressRouting {
  const routing = process.env.PROJECT_INGRESS_ROUTING;
  if (!routing)
    throw new Error("PROJECT_INGRESS_ROUTING unset — the e2e globalSetup/setup did not run");
  return JSON.parse(routing) as IngressRouting;
}

/** `test`, skipped where the worker under test does not route projects by SUBDOMAIN — for what only a
 *  hostname can say: a host label outside the DNS grammar, the dotted `<routingSlug>.<project>` shape, a
 *  site's own `/.auth/*` routes (under paths an app shares the platform's origin, whose routes are the
 *  issuer's). Everything else composes its address with `projectUrl` and runs under both routings. */
export const subdomainsOnly = test.skipIf(ingressRouting()?.type !== "subdomains");

/** THE ONE COMPOSER a row addresses a project with — `projectUrlOf` (iterate/project-ingress)
 *  under the worker's routing and origin: `<routingSlug>--<project>.<hostname>` (the apex `<project>.<hostname>`)
 *  under subdomains, `<worker>/projects/<project>[/<routingSlug>]<path>` under paths. The rows never spell a
 *  host; the platform's own `whoami().projectUrl`, a signed file URL and `itx.url` compose the same way. */
export function projectUrl(target: {
  project: string;
  routingSlug?: string | null;
  path?: string;
}): URL {
  const url = projectUrlOf(ingressRouting(), worker().origin, target);
  if (!url)
    throw new Error(
      `the worker under test has no project ingress — nothing addresses ${JSON.stringify(target)}`,
    );
  return url;
}

/** The URL the config worker receives for `target`: the URL itself under subdomains; under paths
 *  the edge strips the `/projects/<project>[/<routingSlug>]` prefix before the config worker sees
 *  it (and says it in `x-iterate-base-path`), so it sees `path` on the platform's own origin. */
export function appSeesUrl(target: {
  project: string;
  routingSlug?: string | null;
  path?: string;
}): URL {
  const url = projectUrl(target);
  if (ingressRouting()?.type !== "paths") return url;
  const base = `/projects/${target.project}${target.routingSlug ? `/${target.routingSlug}` : ""}`;
  return new URL(`${url.pathname.slice(base.length) || "/"}${url.search}`, url.origin);
}

/** The hostname project hosts hang under — `<routingSlug>--<project>.<hostname>`, the apex
 *  `<project>.<hostname>` — where the worker under test routes projects by subdomain. Only a
 *  `subdomainsOnly` row spells a host with it; every other row composes through `projectUrl`. */
export function ingressHostname(): string {
  const routing = ingressRouting();
  if (routing?.type !== "subdomains")
    throw new Error(
      `the worker under test routes projects ${routing ? "by paths" : "not at all"} — this row needs subdomain routing`,
    );
  return routing.hostname;
}

/** The Agent every project-host request goes through against the local worker: its connector dials
 *  the worker's address and port for ANY hostname, so `http://site--p.localhost/` connects while
 *  the URL — and with it the Host header, as the eyeball spelled it — stays the project host's.
 *  Undefined against a deployed worker: the default dispatcher and the real wildcard DNS. */
let localAgent: Agent | undefined;
function projectHostDispatcher(): Agent | undefined {
  if (!projectHostsAreLocal()) return undefined;
  const connect = buildConnector({});
  localAgent ||= new Agent({
    connect: (options, callback) => {
      const target = worker();
      connect({ ...options, hostname: target.hostname, port: target.port }, callback);
    },
  });
  return localAgent;
}

/** `<scheme>://<host><path>` — `https`/`wss` against a deployed worker, plain against the local one
 *  (whose port the connector dials). */
const projectHostUrl = (scheme: "http" | "ws", host: string, path: string): string =>
  `${scheme}${worker().protocol === "https:" ? "s" : ""}://${host}${path}`;

/** Register the project slugged `slug` with the control plane — `projects.create({ project })` over
 *  the worker's own /api, the catalog row on global:/, the saga opened on the project's / — on the admin
 *  session (the project lands in the deployment's own org) or as `as` (a user's session: their org,
 *  with them a member) — so its host serves, and return its minted id: the DO is addressed by the
 *  id (`openItx(id)`), the host by the slug (`site--<slug>.<base>`). Idempotent; identical against
 *  the local and the deployed worker. */
export async function registerProject(slug: string, as?: { email: string }): Promise<string> {
  using itx = await session().authenticate(adminCredentials(as)).projects.create({ project: slug });
  return (await itx.whoami()).projectId;
}

/** Publish `target` as the project's config worker — what EVERY host of the project reaches, the
 *  routing slug in `x-iterate-routing-slug` — once the project's own creation saga has settled: the
 *  saga publishes the seeded config repo, and an append before it lands would be overwritten. */
export async function publishConfigWorker(itx: any, target: unknown): Promise<void> {
  await itx.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  await itx.append({ type: "events.iterate.com/project/ingress-configured", payload: { target } });
}

/** A fresh project slug — a DNS label, the one the project's hosts carry (`freshCtx` names carry
 *  `_`, which no hostname may). `registerProject(slug)` turns it into a project and hands back the id. */
let counter = 0;
/** `prj-<prefix>-<run>-<worker>-<n>`: the run's id and the worker process's slot (client.ts) keep two
 *  processes' restarted counters, and two runs, apart — a DNS label, lowercase, at most 63 chars. */
export const freshDnsSafeProjectSlug = (prefix: string): string => {
  const slug = `prj-${prefix}-${runId()}-${workerSlot()}-${counter++}`.toLowerCase();
  if (slug.length > 63) throw new Error(`project slug ${slug} exceeds a DNS label (63)`);
  return slug;
};

/** `url` — a project address from `projectUrl`, a signed file URL — a GET, or `init`'s method and
 *  body, through `projectHostDispatcher`. */
export async function fetchProjectUrl(
  url: string | URL,
  headers: Record<string, string> = {},
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const { method = "GET", body } = init;
  const res = await undiciFetch(String(url), {
    method,
    headers,
    body,
    redirect: "manual",
    dispatcher: projectHostDispatcher(),
  });
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
}

/** A GET of `url` with `headers` sent exactly as given — as a browser's page load sends them: fetch
 *  overwrites `Sec-Fetch-Mode` with its own request's mode (`cors`), so a navigation is a plain
 *  HTTP request here — through `projectHostDispatcher`, redirects not followed. */
export async function navigateProjectUrl(
  url: string | URL,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const res = await undiciRequest(String(url), { headers, dispatcher: projectHostDispatcher() });
  return {
    status: res.statusCode,
    headers: Object.fromEntries(
      Object.entries(res.headers).map(([name, value]) => [name, String(value)]),
    ),
    text: await res.body.text(),
  };
}

/** `path` on `host` — a GET, or `init`'s method and body — through `projectHostDispatcher`. For a
 *  host a row spells itself (a custom hostname, a `subdomainsOnly` row); a project address is
 *  `fetchProjectUrl(projectUrl(…))`. */
export async function fetchProjectHost(
  host: string,
  path: string,
  headers: Record<string, string> = {},
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const { method = "GET", body } = init;
  const res = await undiciFetch(projectHostUrl("http", host, path), {
    method,
    headers,
    body,
    redirect: "manual",
    dispatcher: projectHostDispatcher(),
  });
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
}

/** What one eyeball WebSocket round trip saw: `opened` (the 101), the first message, the close code. */
type WebSocketRoundTrip = {
  opened: boolean;
  echo?: string;
  closeCode?: number;
  error?: string;
};

/** One full eyeball WebSocket round trip on a project address (`projectUrl`, its scheme turned to
 *  ws/wss) — open → send → first message → close (1000) — through `projectHostDispatcher`. Never
 *  throws: the caller asserts on the outcome. */
export function wsRoundTripOnProjectUrl(
  url: URL,
  send: string,
  timeoutMs = 10_000,
): Promise<WebSocketRoundTrip> {
  return new Promise((resolve) => {
    const out: WebSocketRoundTrip = { opened: false };
    const ws = new UndiciWebSocket(url.href.replace(/^http/, "ws"), {
      dispatcher: projectHostDispatcher(),
    });
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ ...out, error: out.error || `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    ws.addEventListener("open", () => {
      out.opened = true;
      ws.send(send);
    });
    ws.addEventListener("message", (event) => {
      out.echo = String(event.data);
      ws.close(1000, "done");
    });
    ws.addEventListener("error", (event) => {
      const { error, message } = event as { error?: { message?: string }; message?: string };
      out.error = String(error?.message ?? message ?? "websocket error");
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      out.closeCode = event.code;
      resolve(out);
    });
  });
}
