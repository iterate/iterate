// scripts/preview-readiness.ts — IS A BRAND-NEW WORKER PREVIEW READY FOR TRAFFIC? `/version` naming
// the deployment (the deploy's smoke) proves the stateless Worker serves the new code. It does not
// prove what every e2e row needs next: a WebSocket upgrade on `/api`, and a Durable Object — a fresh
// context and a facet it hosts — answering over it. On a brand-new preview they do not, for seconds
// after `/version` does: the preview's freshly provisioned Durable Object namespace answers calls
// with workerd's opaque `internal error; reference = …` before any Durable Object is invoked (no
// invocation is logged for them). Cloudflare's, not iterate's: fresh-preview-repro.ts reproduces
// it with one 20-line Durable Object class (8 of 12 brand-new previews, for up to 24 s; none of 10
// in-place redeploys; 1 call in ~30,000 on the parent). In CI it failed whole e2e runs:
// main-2eb7238 2026-09-24T00:53 (139 of 145 failed attempts), main-c0812a4 09:00:57, and a fresh-
// preview soak with e2e started at once had 16 of 20 runs fail 50–269 rows each.
//
// `awaitPreviewReady` asks, round after round, until `consecutive` rounds in a row answer in full —
// each round `width` probes at once, each probe its own upgrade and its own fresh context — or the
// deadline passes. Every miss is a warn whose `event` is `preview.platform-failure-readiness`
// (docs/engineering-invariants.md), naming what answered: the upgrade's HTTP status and body, or
// the RPC error. A preview still missing at the deadline fails the deploy with those misses.
//
// AN IN-PLACE REDEPLOY has its own window: its Durable Objects keep running the previous version on
// some hosts for up to ~100 s after `wrangler preview` starts (Workers Logs, 48 soak redeploys), then
// reset with "Durable Object reset because its code was updated.", failing every call in flight. The rounds pass meanwhile, since the
// old version answers them. On 2026-09-24 the ControlPlane singleton answered 238 calls of a soak's
// e2e run on the old version, then reset and failed 16 rows. `holdMs` keeps the rounds going that long
// (every probe's `whoami` reads the ControlPlane), so the reset lands on a probe instead of on e2e.
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:https";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "undici";

/** Wait until the preview at `url` answers `consecutive` full rounds in a row, each `width` probes
 *  at once; throws, naming the misses, when `deadlineMs` passes first. */
export function awaitPreviewReady(
  url: string,
  options: {
    adminSecret: string;
    width: number;
    consecutive: number;
    deadlineMs: number;
    holdMs?: number;
  },
) {
  return awaitFullRounds(() => probeRound(url, options), {
    label: url,
    consecutive: options.consecutive,
    deadlineMs: options.deadlineMs,
    holdMs: options.holdMs,
    pauseMs: 1_000,
  });
}

/** The gate's loop over any round of probes (preview-readiness.test.ts drives it with fakes): a
 *  round with a miss resets the streak, logs one `preview.platform-failure-readiness` warn per miss
 *  and pauses `pauseMs`; the deadline is checked before each round, so a round (every probe at most
 *  20 s) is the most it can overrun by. With `holdMs`, the rounds go on until that long has passed
 *  too, the streak still whole at the end, ten pauses apart once it is. */
export async function awaitFullRounds(
  round: () => Promise<ProbeOutcome[]>,
  options: {
    label: string;
    consecutive: number;
    deadlineMs: number;
    pauseMs: number;
    holdMs?: number;
  },
) {
  const holdMs = options.holdMs || 0;
  const started = Date.now();
  const misses: (ProbeMiss & { atMs: number })[] = [];
  let probes = 0;
  let streak = 0;
  let rounds = 0;
  while (streak < options.consecutive || Date.now() - started < holdMs) {
    if (Date.now() - started > options.deadlineMs)
      throw new Error(
        `preview ${options.label} was not ready within ${options.deadlineMs / 1000} s: ${misses.length} of ${probes} probes missed, the last ${streak} round(s) answered in full\n${misses
          .slice(-10)
          .map((miss) => `  +${miss.atMs} ms ${miss.stage}: ${miss.detail}`)
          .join("\n")}`,
      );
    rounds++;
    const outcomes = await round();
    probes += outcomes.length;
    const missed = outcomes.filter((outcome) => !outcome.ok);
    for (const miss of missed) {
      const atMs = Date.now() - started;
      misses.push({ ...miss, atMs });
      // one line per miss: a slow platform answers dozens of them, and each stays greppable
      console.warn(
        JSON.stringify({
          event: "preview.platform-failure-readiness",
          url: options.label,
          round: rounds,
          atMs,
          stage: miss.stage,
          detail: miss.detail,
        }),
      );
    }
    streak = missed.length === 0 ? streak + 1 : 0;
    if (missed.length > 0) await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
    else if (streak >= options.consecutive && Date.now() - started < holdMs)
      await new Promise((resolve) => setTimeout(resolve, options.pauseMs * 10));
  }
  const ms = Date.now() - started;
  console.log(
    `readiness ok: ${options.label} answered ${options.consecutive} full round(s) in a row after ${(ms / 1000).toFixed(1)} s${holdMs ? `, held ${holdMs / 1000} s` : ""} (${rounds} rounds, ${misses.length} of ${probes} probes missed)`,
  );
  return { rounds, misses, ms };
}

type ProbeMiss = { ok: false; stage: string; detail: string };
type ProbeOutcome = { ok: true; ms: number } | ProbeMiss;

/** `width` probes at once, each on its own connection and its own fresh context. */
function probeRound(url: string, options: { adminSecret: string; width: number }) {
  return Promise.all(Array.from({ length: options.width }, () => probe(url, options.adminSecret)));
}

/** ONE PROBE, at most 20 s: a bare upgrade of `/api` (its status and body are the evidence when it
 *  fails — a WebSocket client never sees them), then a capnweb session on a second socket: `whoami`
 *  on a fresh project context (the context Durable Object), a secret set there (a facet it hosts,
 *  SecretDurableObject) and a one-line `run` (a loaded isolate through the Worker Loader) — the
 *  three things the e2e rows that failed on brand-new previews were doing. The project is
 *  `prj_readiness_<uuid>`, one per probe, so every probe materializes a Durable Object that never
 *  existed. A miss names the step it stopped at. */
async function probe(url: string, adminSecret: string): Promise<ProbeOutcome> {
  const started = Date.now();
  const at = { stage: "upgrade" };
  // What the capnweb transport folds into "WebSocket connection failed.": undici's reason for
  // failing the connection (a non-101 answer, a lost transport), and the close code after it.
  let socketFailure = "";
  let socket: WebSocket | undefined;
  const abandon = new AbortController();
  const steps = async () => {
    const socketUrl = new URL("/api", url);
    const upgrade = await upgradeStatus(socketUrl, abandon.signal);
    if (upgrade.status !== 101)
      throw new Error(`GET /api upgrade answered ${upgrade.status}: ${upgrade.body}`);
    at.stage = "session";
    socketUrl.protocol = "wss:";
    socket = new WebSocket(socketUrl);
    socket.addEventListener("error", (event) => {
      socketFailure = `WebSocket error: ${describe(event.error)}`;
    });
    socket.addEventListener("close", (event) => {
      socketFailure += ` (close ${event.code}${event.reason ? ` ${event.reason}` : ""})`;
    });
    // The call shapes this probe makes, typed here: `iterate/api`'s types need the worker's
    // lib, which tsconfig.scripts.json does not load (the same reason previewSignIn types its own).
    using rpc = newWebSocketRpcSession<{
      authenticate(credentials: { type: "admin-secret"; secret: string }): {
        projects: {
          get(project: string): {
            whoami(): Promise<unknown>;
            run(script: string): Promise<unknown>;
            secrets: {
              set(path: string, value: string, options: { urls: string[] }): Promise<unknown>;
            };
          };
        };
      };
    }>(socket as unknown as globalThis.WebSocket);
    const itx = rpc
      .authenticate({ type: "admin-secret", secret: adminSecret })
      .projects.get(`prj_readiness_${randomUUID().replaceAll("-", "")}`);
    at.stage = "whoami";
    await itx.whoami();
    at.stage = "secrets.set";
    await itx.secrets.set("/secrets/readiness", "probe", { urls: ["https://readiness.invalid"] });
    at.stage = "run";
    await itx.run("async () => 'ready'");
  };
  try {
    await withTimeout(steps(), 20_000);
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      stage: at.stage,
      detail: `${describe(error)}${socketFailure ? `; ${socketFailure}` : ""}`,
    };
  } finally {
    abandon.abort();
    socket?.close();
  }
}

/** The upgrade of `url` as the edge answers it, on a raw HTTPS request of its own connection (a
 *  WebSocket client's shape — never a pooled keep-alive socket): 101 (the socket is dropped at
 *  once), or the status and the first 300 characters of the body. `signal` abandons it (a probe
 *  past its budget leaves no socket open behind it). */
function upgradeStatus(url: URL, signal: AbortSignal) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, {
      agent: false,
      signal,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode!, body: "" });
    });
    req.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode!, body: body.replaceAll(/\s+/g, " ").slice(0, 300) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
