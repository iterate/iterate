// project-host.ts — reach the worker AS a project host (`<label>--<projectId>.<base>`). Node's fetch
// refuses a Host override and `*.localhost` does not resolve on macOS, so against the local worker
// this speaks raw node:http with the Host header set; against a deployed worker the wildcard DNS is
// real and plain fetch does — one test runs both ways.
import http from "node:http";
import { join } from "node:path";
import { test } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { session, workerUrl } from "./client.ts";
import { PACKAGE_DIR } from "./worker-config.ts";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const worker = (): URL => new URL(workerUrl("/"));
/** Is the worker under test the LOCAL one global-setup booted (its project hosts hang under
 *  `localhost`)? The deployed proof sets WORKER_BASE_URL to a real hostname. */
export const projectHostsAreLocal = (): boolean => LOCAL_HOSTNAMES.has(worker().hostname);
/** `test`, skipped against the local worker — for what only a real deployment can prove (Artifacts,
 *  the real AI binding, a Host-carrying WebSocket upgrade). The ONE gate; never copy the regex. */
export const deployedOnly = test.skipIf(projectHostsAreLocal());

/** The base project hosts hang under: `localhost` for the local worker (worker-config.ts), the
 *  deployed worker's `APP_CONFIG_PROJECT_HOSTNAME_BASE` (wrangler.jsonc) otherwise. */
export function projectHostnameBase(): string {
  if (projectHostsAreLocal()) return "localhost";
  const { rawConfig } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  return String((rawConfig.vars as Record<string, unknown>).APP_CONFIG_PROJECT_HOSTNAME_BASE);
}

/** Register `projectId` with the directory — `authenticate().projects.create({ slug })` over the
 *  worker's own /api (open login mode: the anonymous user may create projects) — so its host serves.
 *  A project's id IS its slug (a DNS label), so one name addresses both the DO (`openItx(projectId)`)
 *  and the host (`site--<projectId>.<base>`). Idempotent; identical against the local and the
 *  deployed worker. */
export async function registerProject(projectId: string): Promise<void> {
  await session().authenticate().projects.create({ slug: projectId });
}

/** A project id that is a DNS label — the convention needs one (`freshCtx` names carry `_`). */
let counter = 0;
export const freshDnsSafeProjectId = (prefix: string): string =>
  `prj-${prefix}-${Date.now().toString(36)}-${counter++}`;

/** GET `path` on `host`: with the Host header against the local worker, over the real wildcard DNS
 *  against a deployed one. */
export async function fetchProjectHost(
  host: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const target = worker();
  if (!projectHostsAreLocal()) {
    const res = await fetch(`${target.protocol}//${host}${path}`, { headers, redirect: "manual" });
    return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path,
        method: "GET",
        headers: { ...headers, host },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([name, value]) => [name, String(value)]),
            ),
            text: body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
