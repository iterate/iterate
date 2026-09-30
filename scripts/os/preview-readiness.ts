// scripts/os/preview-readiness.ts — IS A DEPLOYMENT READY FOR TRAFFIC? The deploy's smoke of core/os,
// asked as soon as its worker is uploaded. Every e2e row needs a WebSocket upgrade on
// `/api`, and a Durable Object — a fresh context and a facet it hosts — answering over it on the
// deploy's version. On a brand-new preview they do not, for seconds after its edge serves the new
// version (`/version` naming it): the preview's freshly provisioned Durable Object namespace
// answers calls with workerd's opaque `internal error; reference = …` before any Durable Object is
// invoked (no invocation is logged for them). Cloudflare's, not iterate's:
// github.com/iterate/fresh-preview-repro reproduces it with one 20-line Durable Object class (8 of
// 12 brand-new previews, for up to 24 s; none of 10 in-place redeploys; 1 call in ~30,000 on the
// parent). An e2e suite started on such a preview fails rows by the dozen.
//
// `awaitPreviewReady` asks, round after round, until `consecutive` rounds in a row answer in full —
// each round `width` probes at once, each probe its own upgrade and its own fresh context — or the
// deadline passes. Every miss is a warn whose `event` is `preview.platform-failure-readiness`
// (docs/engineering-invariants.md), naming what answered: the upgrade's HTTP status and body, or
// the RPC error. A preview still missing at the deadline fails the deploy with those misses.
//
// A PREVIEW REDEPLOYED IN PLACE answers at once, partly on the previous version: Cloudflare releases
// a new version eventually consistently ("typically seconds to minutes",
// https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates). For a while
// an edge can still serve it and a brand-new Durable Object can still start on it, and an object on
// it later resets with "Durable Object reset because its code was updated.", failing every call in
// flight. So each probe also asks the operator's `session.versions` (core/os/src/session.ts) which version
// its edge (the id `/version` answers with), its own context and another brand-new one run, and
// misses (`stage: "version"`) when any is not the deploy's: the gate passes once `consecutive`
// rounds in a row run the deploy's version everywhere they look.
//
// A BRAND-NEW HOSTNAME reaches Cloudflare's servers one by one, and a probe that lands on one it has
// not reached yet gets Cloudflare's own not-found, which its miss names (`isNotRoutedYet`). The
// rounds only sample connections, so the suites' transport sends such a request again too
// (test/helpers/not-routed.ts).
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:https";
import { newWebSocketRpcSession } from "capnweb";
import { isNotRoutedYet } from "iterate/platform-retry";
import type { IterateApi } from "iterate/api";
import { WebSocket } from "undici";

/** How long the gate asks before it fails the deploy: well past the slowest in-place redeploy
 *  measured, 58 s. */
const DEADLINE_MS = 150_000;

/** Wait until the preview at `url` answers `consecutive` full rounds in a row on `version` (the
 *  deployment's id), each `width` probes at once; throws, naming the misses, when DEADLINE_MS passes
 *  first. */
export function awaitPreviewReady(
  url: string,
  options: {
    adminSecret: string;
    version: string;
    width: number;
    consecutive: number;
  },
) {
  return awaitFullRounds(() => probeRound(url, options), {
    label: url,
    consecutive: options.consecutive,
  });
}

/** The gate's loop over any round of probes (preview-readiness.test.ts drives it with fakes): a
 *  round with a miss resets the streak, logs one `preview.platform-failure-readiness` warn per miss
 *  and pauses 1 s; DEADLINE_MS is checked before each round, so a round (every probe at most 20 s)
 *  is the most it can overrun by. */
export async function awaitFullRounds(
  round: () => Promise<ProbeOutcome[]>,
  options: { label: string; consecutive: number },
) {
  const started = Date.now();
  const misses: (ProbeMiss & { atMs: number })[] = [];
  let probes = 0;
  let streak = 0;
  let rounds = 0;
  while (streak < options.consecutive) {
    if (Date.now() - started > DEADLINE_MS)
      throw new Error(
        `preview ${options.label} was not ready within ${DEADLINE_MS / 1000} s: ${misses.length} of ${probes} probes missed, the last ${streak} round(s) answered in full\n${misses
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
    if (missed.length > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const ms = Date.now() - started;
  console.log(
    `readiness ok: ${options.label} answered ${options.consecutive} full round(s) in a row after ${(ms / 1000).toFixed(1)} s (${rounds} rounds, ${misses.length} of ${probes} probes missed)`,
  );
  return { rounds, misses, ms };
}

type ProbeMiss = { ok: false; stage: string; detail: string };
type ProbeOutcome = { ok: true; ms: number } | ProbeMiss;

/** `width` probes at once, each on its own connection and its own fresh context. */
function probeRound(url: string, options: { adminSecret: string; version: string; width: number }) {
  return Promise.all(
    Array.from({ length: options.width }, () => probe(url, options.adminSecret, options.version)),
  );
}

/** How many brand-new contexts each probe asks the version of: its own and one that exists only to
 *  be asked. A brand-new Durable Object starts on whichever version its host runs, so the gate
 *  samples placements: with one per probe, 6 of 48 soak redeploys still had an e2e context start on
 *  the previous version after the gate passed; with four, 2 of 48 (2026-09-24). With two, and three
 *  rounds in a row, 1 of 20 still ran calls on the previous version, as did 1 of 20 with four and
 *  five rounds beside it (2026-09-26). */
const CONTEXTS_PER_PROBE = 2;

/** ONE PROBE, at most 20 s: a bare upgrade of `/api` (its status and body are the evidence when it
 *  fails — a WebSocket client never sees them), then a capnweb session on a second socket: `whoami`
 *  on a fresh project context (the context Durable Object), a secret set there (a facet it hosts,
 *  SecretDurableObject) and a one-line `run` (a loaded isolate through the Worker Loader) — the
 *  three things the e2e rows that failed on brand-new previews were doing — then `versions`, which
 *  version its edge, that context and another brand-new one run. Every project is
 *  `prj_readiness_<uuid>`, so every probe materializes Durable Objects that never existed. A miss
 *  names the step it stopped at. */
async function probe(url: string, adminSecret: string, version: string): Promise<ProbeOutcome> {
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
      throw new Error(
        isNotRoutedYet(upgrade)
          ? `GET /api upgrade answered Cloudflare's own not-found (${upgrade.status}, cf-ray ${upgrade.headers["cf-ray"]}): the server it reached does not route this hostname yet`
          : `GET /api upgrade answered ${upgrade.status}: ${upgrade.body}`,
      );
    at.stage = "session";
    socketUrl.protocol = "wss:";
    socket = new WebSocket(socketUrl);
    socket.addEventListener("error", (event) => {
      socketFailure = `WebSocket error: ${describe(event.error)}`;
    });
    socket.addEventListener("close", (event) => {
      socketFailure += ` (close ${event.code}${event.reason ? ` ${event.reason}` : ""})`;
    });
    // Undici implements the WebSocket transport capnweb consumes.
    using rpc = newWebSocketRpcSession<IterateApi>(socket as unknown as globalThis.WebSocket);
    const session = rpc.authenticate({ type: "admin-secret", secret: adminSecret });
    const [project, ...more] = Array.from(
      { length: CONTEXTS_PER_PROBE },
      () => `prj_readiness_${randomUUID().replaceAll("-", "")}`,
    );
    const itx = session.projects.get(project);
    at.stage = "whoami";
    await itx.whoami();
    at.stage = "secrets.set";
    await itx.secrets.set("/secrets/readiness", "probe", { urls: ["https://readiness.invalid"] });
    at.stage = "run";
    await itx.run("async () => 'ready'");
    at.stage = "version";
    const { edge, contexts } = await session.versions([project, ...more]);
    const behind = [
      ...(edge === version ? [] : [`the edge runs ${edge}`]),
      ...contexts
        .filter((context) => context !== version)
        .map((context) => `a brand-new context runs ${context}`),
    ];
    if (behind.length > 0) throw new Error(`${behind.join("; ")}, not ${version}`);
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
 *  once), or the status, the headers and the first 300 characters of the body. `signal` abandons
 *  it (a probe past its budget leaves no socket open behind it). */
function upgradeStatus(url: URL, signal: AbortSignal) {
  return new Promise<UpgradeAnswer>((resolve, reject) => {
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
      resolve({ status: response.statusCode!, headers: response.headers, body: "" });
    });
    req.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode!,
          headers: response.headers,
          body: body.replaceAll(/\s+/g, " ").slice(0, 300),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

type UpgradeAnswer = { status: number; headers: IncomingHttpHeaders; body: string };

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
