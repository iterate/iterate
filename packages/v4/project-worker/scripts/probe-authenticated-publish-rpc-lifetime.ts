/**
 * Separate the public Docs publish operations for a delayed native-RPC lifetime audit.
 *
 * Run against a deployed worker, then query telemetry after the native lifetime window:
 *
 *   WORKER_BASE_URL=https://v4.iterate2.app WORKER_DEMO_LOGIN=1 \
 *     pnpm exec tsx scripts/probe-authenticated-publish-rpc-lifetime.ts
 *
 * The script prints the run id, each fresh context, and UTC timing. It performs no retry and
 * disposes each public session after its operation. The final `publish` arm deliberately keeps
 * Docs' one-session order: repo.head → repo.commit → check → build → activation append.
 * It proves public results only; delayed native telemetry classifies the outer DO invocations.
 */

import { createRequire } from "node:module";
import { WebSocket } from "undici";

const { newWebSocketRpcSession } = createRequire(import.meta.url)("capnweb") as {
  newWebSocketRpcSession(webSocket: WebSocket): any;
};

const baseUrl = process.env.WORKER_BASE_URL?.trim();
if (!baseUrl) throw new Error("Set WORKER_BASE_URL to the deployment under observation.");
if (process.env.WORKER_DEMO_LOGIN !== "1") {
  throw new Error("Set WORKER_DEMO_LOGIN=1 to authorize the probe's demo login.");
}
const runId = process.env.PUBLISH_LIFETIME_RUN_ID?.trim() || crypto.randomUUID();
if (!/^[a-z0-9-]{1,80}$/i.test(runId))
  throw new Error("PUBLISH_LIFETIME_RUN_ID must contain only letters, numbers, and hyphens.");

const base = new URL(baseUrl);
const startedAt = Date.now();
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      event,
      runId,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      ...fields,
    }),
  );

const login = await fetch(new URL("/login", base), {
  method: "POST",
  redirect: "manual",
  body: new URLSearchParams({ email: "v4-lifetime-proof@iterate.invalid" }),
  headers: { origin: base.origin, "content-type": "application/x-www-form-urlencoded" },
});
if (login.status !== 303) throw new Error(`Demo login returned ${login.status}.`);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Demo login did not return a session cookie.");

const apiUrl = new URL("/api", base);
apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";

const withItx = async <T>(
  operation: string,
  run: (itx: any, context: string) => Promise<T>,
): Promise<T> => {
  const context = `prj_publish_lifetime_${runId}_${operation}`;
  const socket = new WebSocket(apiUrl, { headers: { cookie, origin: base.origin } });
  const session = newWebSocketRpcSession(socket);
  const itx = session.authenticate().projects.get(context);
  log("operation-start", { operation, context });
  try {
    const result = await run(itx, context);
    log("operation-complete", { operation, context });
    return result;
  } catch (error) {
    log("operation-failed", {
      operation,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    session[Symbol.dispose]();
    socket.close();
    log("operation-session-disposed", { operation, context });
  }
};

const files = {
  "src/main.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class ProbeApp extends WorkerEntrypoint {
  fetch() { return new Response("publish-lifetime"); }
}`,
};
const directInput = { files, options: { entryPoint: "src/main.ts" } };

await withItx("head", async (itx) => {
  const head = await itx.repos.get(`/probe/${runId}`).head();
  if (head !== null) throw new Error("Fresh probe repository unexpectedly has a head.");
});

await withItx("commit", async (itx) => {
  const revision = await itx.repos.get(`/probe/${runId}`).commit({
    parent: null,
    message: `publish lifetime ${runId}`,
    files,
  });
  if (typeof revision?.revision !== "string")
    throw new Error("Repository commit returned no revision.");
});

await withItx("check", async (itx) => {
  const checked = await itx.check(directInput);
  if (checked.status !== "checked") throw new Error("Probe source unexpectedly failed check.");
});

await withItx("build", async (itx) => {
  const built = await itx.build(directInput);
  if (built.status !== "built") throw new Error("Probe source unexpectedly failed build.");
});

await withItx("append", async (itx) => {
  await itx.invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/publish-lifetime-probe/appended",
        idempotencyKey: `publish-lifetime:${runId}:append`,
        payload: { runId },
      },
    ],
  ]);
});

await withItx("publish", async (itx) => {
  const repo = itx.repos.get(`/probe/${runId}/publish`);
  const head = await repo.head();
  const revision = await repo.commit({
    parent: head?.revision ?? null,
    message: `publish lifetime ${runId}`,
    files,
  });
  const source = {
    source: { repo: `/probe/${runId}/publish`, revision: revision.revision },
    options: { entryPoint: "src/main.ts" },
  };
  const checked = await itx.check(source);
  if (checked.status !== "checked")
    throw new Error("Published probe source unexpectedly failed check.");
  const built = await itx.build(source);
  if (built.status !== "built")
    throw new Error("Published probe source unexpectedly failed build.");
  await itx.invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/publish-lifetime-probe/activated",
        idempotencyKey: `publish-lifetime:${runId}:activated`,
        payload: { runId, revision: revision.revision, buildKey: built.key },
      },
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        idempotencyKey: `publish-lifetime:${runId}:rule`,
        payload: {
          match: "itx.publishLifetimeProbe",
          target: `itx.workers.load(${JSON.stringify(built.code)}, { cacheKey: ${JSON.stringify(built.key)} })`,
        },
      },
    ],
  ]);
});

log("probe-complete");
