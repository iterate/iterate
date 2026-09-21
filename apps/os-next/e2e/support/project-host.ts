// project-host.ts — reach the worker AS a project host (`<app>--<project>.<base>`, the one HTTP way
// into a project). Against the local worker the hosts hang under `localhost`, which macOS does not
// resolve and Node's fetch will not let a test override, so every request rides an undici Agent
// whose connector dials the worker's own address and port whatever the URL says — the URL, the
// Host header, cookies, bearers and a WebSocket upgrade all intact; against a deployed worker the
// wildcard DNS is real and the default dispatcher does. One test runs both ways.
import { Agent, buildConnector, fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";
import { test } from "vitest";
import { adminCredentials, runId, session, workerSlot, workerUrl } from "./client.ts";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const worker = (): URL => new URL(workerUrl("/"));
/** Is the worker under test the LOCAL one global-setup booted (its project hosts hang under
 *  `localhost`)? The deployed proof sets WORKER_BASE_URL to a real hostname. */
export const projectHostsAreLocal = (): boolean => LOCAL_HOSTNAMES.has(worker().hostname);
/** `test`, skipped against the local worker — for what only a real deployment can prove (Artifacts,
 *  the real AI binding, an app's fetch back into its own host). The ONE gate; never copy the regex. */
export const deployedOnly = test.skipIf(projectHostsAreLocal());
/** `test`, skipped against a DEPLOYED worker — for rows that lend the fake git remote
 *  (support/fake-git-server.ts, listening on THIS machine's 127.0.0.1): the repo facet fetches its
 *  remote over the worker's egress, and a deployed worker cannot reach a loopback address (the
 *  platform answers 403). Rows that only touch the proxy (create, its failure) still run deployed —
 *  the fake proxy is called back over the WebSocket — and the real binding's rows run `deployedOnly`. */
export const localOnly = test.skipIf(!projectHostsAreLocal());

/** Does the worker under test HAVE project-host ingress at all? The local worker always does (its
 *  hosts hang under `localhost`); a deployed one only where `APP_CONFIG_PROJECT_HOSTNAME_BASE` names
 *  a base. A `*.workers.dev` preview deploy leaves it blank — workers.dev has no wildcard
 *  subdomains, and the `previews` config block has no routes — so `<app>--<project>.<base>` exists
 *  nowhere to dial there, by design. */
export const projectHostsAvailable = (): boolean =>
  projectHostsAreLocal() || Boolean(process.env.PROJECT_HOSTNAME_BASE);

/** `test`, for a row that DIALS a project host: it runs against the local worker and against a
 *  deployment that has the ingress, and skips against one that does not (the helper's NAME is the
 *  reason). Every row reaching `projectHostnameBase()` goes through this or `deployedOnProjectHost`;
 *  `projectHostnameBase()` still throws for a caller that reached it through neither. */
export const onProjectHost = test.skipIf(!projectHostsAvailable());

/** `deployedOnly` AND `onProjectHost`: a row only a real deployment can prove, on a host only a
 *  deployment that has the ingress owns. */
export const deployedOnProjectHost = test.skipIf(
  projectHostsAreLocal() || !projectHostsAvailable(),
);

/** The base project hosts hang under: `localhost` for the local worker (worker-config.ts), the
 *  deployed worker's `APP_CONFIG_PROJECT_HOSTNAME_BASE` (wrangler.jsonc) otherwise. */
export function projectHostnameBase(): string {
  if (projectHostsAreLocal()) return "localhost";
  const base = process.env.PROJECT_HOSTNAME_BASE;
  if (!base) throw new Error("PROJECT_HOSTNAME_BASE is required for deployed ingress tests");
  return base;
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

/** Register the project slugged `slug` with the directory — `projects.create({ project })` over the
 *  worker's own /api, on the admin session (the project lands in the deployment's own org) or as
 *  `as` (a user's session: their org, with them a member) — so its host serves, and return its
 *  minted id: the DO is addressed by the id (`openItx(id)`), the host by the slug
 *  (`site--<slug>.<base>`). Idempotent; identical against the local and the deployed worker. */
export async function registerProject(slug: string, as?: { email: string }): Promise<string> {
  using itx = await session().authenticate(adminCredentials(as)).projects.create({ project: slug });
  return (await itx.whoami()).projectId;
}

/** A fresh project slug — a DNS label, the one the project's hosts carry (`freshCtx` names carry
 *  `_`, which no hostname may). `registerProject(slug)` turns it into a project and hands back the id.
 *  Same shape as `freshCtx`: the run's id and this worker process's slot, then a per-process counter
 *  — unique across runs and across the processes running files in parallel. */
let counter = 0;
export const freshDnsSafeProjectSlug = (prefix: string): string => {
  const slug = `prj-${prefix}-${runId()}-${workerSlot()}-${counter++}`.toLowerCase();
  if (slug.length > 63) throw new Error(`project slug "${slug}" is longer than a DNS label allows`);
  return slug;
};

/** `path` on `host` — a GET, or `init`'s method and body — through `projectHostDispatcher`. */
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
export type WebSocketRoundTrip = {
  opened: boolean;
  echo?: string;
  closeCode?: number;
  error?: string;
};

/** One full eyeball WebSocket round trip on a project host — open → send → first message → close
 *  (1000) — through `projectHostDispatcher`. Never throws: the caller asserts on the outcome. */
export function wsRoundTripOnProjectHost(
  host: string,
  path: string,
  send: string,
  timeoutMs = 10_000,
): Promise<WebSocketRoundTrip> {
  return new Promise((resolve) => {
    const out: WebSocketRoundTrip = { opened: false };
    const ws = new UndiciWebSocket(projectHostUrl("ws", host, path), {
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
