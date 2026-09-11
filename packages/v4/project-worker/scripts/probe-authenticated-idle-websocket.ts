/**
 * Observe an authenticated public `/api` socket while it is idle.
 *
 * Usage (the login is deliberately opt-in):
 *   WORKER_BASE_URL=https://v4.iterate2.app WORKER_DEMO_LOGIN=1 IDLE_PROBE_DURATION_MS=480000 \
 *     pnpm exec tsx scripts/probe-authenticated-idle-websocket.ts
 *
 * It prints only timing, close codes/reasons, and RPC errors — never the
 * browser cookie — and creates one fresh disposable context name.
 */
import { createRequire } from "node:module";
import { WebSocket } from "undici";
import { connectLiveState } from "../src/client/live-state-client.ts";

// The scripts config intentionally does not consume capnweb's browser-facing
// declaration graph; load this Node-only probe dependency at runtime instead.
const { newWebSocketRpcSession } = createRequire(import.meta.url)("capnweb") as {
  newWebSocketRpcSession(webSocket: WebSocket): any;
};

const baseUrl = process.env.WORKER_BASE_URL?.trim();
if (!baseUrl) throw new Error("Set WORKER_BASE_URL to the deployment under observation.");
if (process.env.WORKER_DEMO_LOGIN !== "1") {
  throw new Error("Set WORKER_DEMO_LOGIN=1 to authorize the probe's demo login.");
}
const idleDurationMs = Number(process.env.IDLE_PROBE_DURATION_MS ?? "175000");
if (!Number.isInteger(idleDurationMs) || idleDurationMs < 25_000 || idleDurationMs > 480_000) {
  throw new Error("IDLE_PROBE_DURATION_MS must be an integer from 25000 through 480000.");
}

const base = new URL(baseUrl);
const login = await fetch(new URL("/login", base), {
  method: "POST",
  redirect: "manual",
  body: new URLSearchParams({ email: "test@iterate.invalid" }),
  headers: { origin: base.origin, "content-type": "application/x-www-form-urlencoded" },
});
if (login.status !== 303) throw new Error(`Login returned ${login.status}.`);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie) throw new Error("Login did not set a session cookie.");

const apiUrl = new URL("/api", base);
apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
const startedAt = Date.now();
const socket = new WebSocket(apiUrl, { headers: { cookie, origin: base.origin } });
const elapsed = () => Date.now() - startedAt;
let shuttingDown = false;
let resolveClose!: () => void;
const closed = new Promise<void>((resolve) => {
  resolveClose = resolve;
});

socket.addEventListener("close", (event) => {
  console.log(
    JSON.stringify({
      event: "websocket-close",
      elapsedMs: elapsed(),
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      phase: shuttingDown ? "teardown" : "monitoring",
    }),
  );
  resolveClose();
});
socket.addEventListener("error", (event) => {
  const error =
    event.error instanceof Error ? event.error.message : String(event.error ?? "WebSocket error");
  console.log(JSON.stringify({ event: "websocket-error", elapsedMs: elapsed(), error }));
});

const session = newWebSocketRpcSession(socket as any) as any;
session.onRpcBroken((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ event: "rpc-broken", elapsedMs: elapsed(), error: message }));
});

const identity = await session.authenticate().identity();
const context = `prj_idle_probe_${Date.now().toString(36)}`;
const itx = session.authenticate().projects.get(context);
const whoami = await itx.whoami();
console.log(
  JSON.stringify({
    event: "established",
    elapsedMs: elapsed(),
    identity,
    context,
    whoami,
    idleDurationMs,
  }),
);
// This is the same LIVE callback subscription shape Docs creates. The fresh
// context has no producer, so the seed is deliberately local; the purpose is
// to hold the subscription's lent callback/pager while the public `/api`
// session itself stays otherwise idle.
const live = await connectLiveState<null>(itx, {
  key: "idle-probe",
  name: `idle-probe-${crypto.randomUUID()}`,
  door: async () => ({ rev: 0, state: null }),
});
console.log(JSON.stringify({ event: "live-subscription-established", elapsedMs: elapsed() }));

for (let waitedMs = 0; waitedMs < idleDurationMs; ) {
  const nextWaitMs = Math.min(25_000, idleDurationMs - waitedMs);
  const outcome = await Promise.race([
    closed.then(() => "closed"),
    sleep(nextWaitMs).then(() => "idle"),
  ]);
  if (outcome === "closed") {
    session[Symbol.dispose]();
    process.exitCode = 1;
    break;
  }
  waitedMs += nextWaitMs;
  console.log(JSON.stringify({ event: "idle", elapsedMs: elapsed() }));
}

if (socket.readyState === WebSocket.OPEN) {
  try {
    const ping = await Promise.race([
      itx.whoami(),
      sleep(25_000).then(() => Promise.reject(new Error("Idle ping timed out after 25 seconds."))),
    ]);
    console.log(JSON.stringify({ event: "idle-ping", elapsedMs: elapsed(), whoami: ping }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({ event: "idle-ping-failed", elapsedMs: elapsed(), error: message }),
    );
    process.exitCode = 1;
  }
}

shuttingDown = true;
await live.dispose();
session[Symbol.dispose]();
socket.close();
await Promise.race([closed, sleep(5_000)]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
