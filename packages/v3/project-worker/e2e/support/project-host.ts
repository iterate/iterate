// project-host.ts — reach the worker AS a project host (`<app>--<project>.<base>`, the one HTTP way
// into a project). Against the local worker the hosts hang under `localhost`, which macOS does not
// resolve and Node's fetch will not let a test override, so every request rides an undici Agent
// whose connector dials the worker's own address and port whatever the URL says — the URL, the
// Host header, cookies, bearers and a WebSocket upgrade all intact; against a deployed worker the
// wildcard DNS is real and the default dispatcher does. One test runs both ways.
import { join } from "node:path";
import { Agent, buildConnector, fetch as undiciFetch, WebSocket as UndiciWebSocket } from "undici";
import { test } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { adminCredentials, session, workerUrl } from "./client.ts";
import { PACKAGE_DIR } from "./worker-config.ts";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const worker = (): URL => new URL(workerUrl("/"));
/** Is the worker under test the LOCAL one global-setup booted (its project hosts hang under
 *  `localhost`)? The deployed proof sets WORKER_BASE_URL to a real hostname. */
export const projectHostsAreLocal = (): boolean => LOCAL_HOSTNAMES.has(worker().hostname);
/** `test`, skipped against the local worker — for what only a real deployment can prove (Artifacts,
 *  the real AI binding, an app's fetch back into its own host). The ONE gate; never copy the regex. */
export const deployedOnly = test.skipIf(projectHostsAreLocal());

/** The base project hosts hang under: `localhost` for the local worker (worker-config.ts), the
 *  deployed worker's `APP_CONFIG_PROJECT_HOSTNAME_BASE` (wrangler.jsonc) otherwise. */
export function projectHostnameBase(): string {
  if (projectHostsAreLocal()) return "localhost";
  const { rawConfig } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  return String((rawConfig.vars as Record<string, unknown>).APP_CONFIG_PROJECT_HOSTNAME_BASE);
}

/** The Agent every project-host request goes through against the local worker: its connector dials
 *  the worker's address and port for ANY hostname, so `http://site--p.localhost/` connects while
 *  the URL — and with it the Host header, as the eyeball spelled it — stays the project host's.
 *  Undefined against a deployed worker: the default dispatcher and the real wildcard DNS. */
let localAgent: Agent | undefined;
function projectHostDispatcher(): Agent | undefined {
  if (!projectHostsAreLocal()) return undefined;
  const connect = buildConnector({});
  localAgent ??= new Agent({
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

/** Register `projectId` with the directory — `projects.create({ project })` over the worker's own
 *  /api, on the admin session (the project lands in the deployment's own org) or as `as` (a user's
 *  session: their org, with them a member) — so its host serves. A project's id IS its slug (a DNS
 *  label), so one name addresses both the DO (`openItx(projectId)`) and the host
 *  (`site--<projectId>.<base>`). Idempotent; identical against the local and the deployed worker. */
export async function registerProject(projectId: string, as?: { email: string }): Promise<void> {
  await session().authenticate(adminCredentials(as)).projects.create({ project: projectId });
}

/** A project id that is a DNS label — the convention needs one (`freshCtx` names carry `_`). */
let counter = 0;
export const freshDnsSafeProjectId = (prefix: string): string =>
  `prj-${prefix}-${Date.now().toString(36)}-${counter++}`;

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
      resolve({ ...out, error: out.error ?? `timeout after ${timeoutMs}ms` });
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
