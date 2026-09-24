// perf/project-creation.perf.test.ts — CONCURRENT PROJECT CREATION, the regression the latency guard
// exists for: creating many projects at once used to be practically instant, and more than once it
// quietly became slow (#1601: first-touch creates of 60–120 s behind dead routes; #2168: ~6–8 s warm,
// ~20 s cold; #2828's control-plane-load: 1000 at once took 70 s, projects.create p95 24.5 s). Here N
// people (1, 10, 25) each create their first project AT ONCE, each on a socket of their own as N
// dashboards would, signed in as themselves (the operator's `as`, a sign-in's own find-or-create).
// Every project is timed from the call:
//   answered — `projects.create` returned: the person, the catalog row on the control plane (one
//              singleton Durable Object, so N at once queue there), the project's saga opened;
//   ready    — its `project/created` certificate is on `/`: the config repo seeded and published,
//              the apex serving it (session.e2e proves that sequence; this times it).
// and each round until its LAST project is ready. A project that is not ready by READY_DEADLINE_MS,
// whose create threw or whose saga failed (`project/create-failed`, its error printed with the
// round), counts as READY_DEADLINE_MS: a creation that stalls or fails under load is the slowness
// this guards, never a broken probe. The network between the runner and Cloudflare's edge is not
// what it guards: a person's socket that fails, or does not open within SOCKET_OPEN_MS, is opened
// once more, logged (`perf.socket-reopened`), and the project still timed from its first call.
//
// Where the time goes (25 at once, 2026-09-24, from the log's own stamps): Cloudflare Artifacts. The
// config repo's `repo/created` lands 3.4–8.3 s after the request and its seed `repo/commit-completed`
// 1.6–7.4 s after that; the ingress and the certificate take under a second. The median project is
// ready in ~5–7 s at 1, 10 and 25 at once alike; the slowest of a round of 25, 2–3× that.

import { test } from "vitest";
import { adminCredentials, rawSession, sleep } from "../e2e/support/client.ts";
import { freshDnsSafeProjectSlug } from "../e2e/support/project-host.ts";
import type { LatencyMetricName } from "./latency.ts";
import { recordLatency } from "./record.ts";

const READY_DEADLINE_MS = 60_000;
/** How long a person's socket may take to open before it is opened once more. The edge upgrades
 *  one in 0.1–0.7 s; on 2026-09-24 one upgrade of a round of 25 reached the Worker 56.7 s late, and
 *  another socket was lost 10.5 s after it opened. */
const SOCKET_OPEN_MS = 10_000;

test.for([
  {
    people: 1,
    rounds: 5,
    metrics: { answered: "project.create.x1.answered", ready: "project.create.x1.ready" },
  },
  {
    people: 10,
    rounds: 3,
    metrics: {
      answered: "project.create.x10.answered",
      ready: "project.create.x10.ready",
      allReady: "project.create.x10.all-ready",
    },
  },
  {
    people: 25,
    rounds: 3,
    metrics: {
      answered: "project.create.x25.answered",
      ready: "project.create.x25.ready",
      allReady: "project.create.x25.all-ready",
    },
  },
] satisfies {
  people: number;
  rounds: number;
  metrics: Record<"answered" | "ready", LatencyMetricName> & { allReady?: LatencyMetricName };
}[])(
  "$people people create their first project at once, $rounds rounds: answered, ready, and the round until the last is ready",
  // the worst case: the warm-up and every round waiting out READY_DEADLINE_MS
  { timeout: 420_000 },
  async ({ people, rounds, metrics }, { task }) => {
    // one untimed creation first: the preview's first touch (a cold isolate, the control plane's
    // first wake) is not the steady state this measures
    await createProject("lat-warm");
    const answered: number[] = [];
    const ready: number[] = [];
    const allReady: number[] = [];
    for (let round = 1; round <= rounds; round++) {
      const started = performance.now();
      const projects = await Promise.all(
        Array.from({ length: people }, () => createProject(`lat${people}`)),
      );
      allReady.push(performance.now() - started);
      answered.push(...projects.map((project) => project.answeredMs));
      ready.push(...projects.map((project) => project.readyMs));
      const failed = projects.flatMap((project) => (project.error ? [project.error] : []));
      console.log(
        `[x${people} round ${round}] all ready in ${allReady.at(-1)!.toFixed(0)}ms${failed.length ? `; ${failed.length} not ready: ${failed.join("; ")}` : ""}`,
      );
      if (failed.length === people)
        throw new Error(`no project of ${people} became ready: ${failed.join("; ")}`);
    }
    recordLatency(task, metrics.answered, answered);
    recordLatency(task, metrics.ready, ready);
    // one person's round is its one project: `ready` already says it
    if (metrics.allReady) recordLatency(task, metrics.allReady, allReady);
  },
);

/** One person's first project: signed in as a fresh email on a socket of its own, `projects.create`,
 *  then its log read from the cursor every 100 ms until `project/created` (a read per poll, so a
 *  sample is at most one poll and one round trip late), or `project/create-failed`. A throw, a
 *  failure or a miss of the deadline answers the deadline, with the reason. A socket that fails
 *  before it opens, or is lost after, is opened ONCE more: `projects.create` asks again for the same
 *  project (the same person's slug is the same project), and the log is read on from the cursor. */
async function createProject(prefix: string) {
  const slug = freshDnsSafeProjectSlug(prefix);
  const credentials = adminCredentials({ email: `${slug}@example.com` });
  const started = performance.now();
  let answeredMs = READY_DEADLINE_MS;
  let after = 0;
  let reopened = false;
  for (;;) {
    const { session, ws } = rawSession();
    try {
      await opened(ws);
      const itx = await session.authenticate(credentials).projects.create({ project: slug });
      answeredMs = Math.min(answeredMs, performance.now() - started);
      for (; performance.now() - started < READY_DEADLINE_MS; await sleep(100)) {
        const page = await itx.invoke(["itx", ["readEvents", after, 100]]);
        for (const event of page.events as { type: string; payload?: { error?: string } }[]) {
          if (event.type === "events.iterate.com/project/created")
            return { answeredMs, readyMs: performance.now() - started };
          if (event.type === "events.iterate.com/project/create-failed")
            return {
              answeredMs,
              readyMs: READY_DEADLINE_MS,
              error: `${slug}: project/create-failed: ${event.payload?.error}`,
            };
        }
        after = page.scannedThroughOffset;
      }
      return { answeredMs, readyMs: READY_DEADLINE_MS, error: `${slug}: not ready in time` };
    } catch (error) {
      const lost = ws.readyState !== WebSocket.OPEN;
      if (!lost || reopened || performance.now() - started >= READY_DEADLINE_MS)
        return { answeredMs, readyMs: READY_DEADLINE_MS, error: `${slug}: ${String(error)}` };
      reopened = true;
      console.warn({
        event: "perf.socket-reopened",
        slug,
        atMs: Math.round(performance.now() - started),
        answered: answeredMs < READY_DEADLINE_MS,
        error: String(error),
      });
    } finally {
      try {
        session[Symbol.dispose]();
      } catch {
        /* already broken */
      }
    }
  }
}

/** Resolves once `ws` is open; rejects when it fails first, or has not opened in SOCKET_OPEN_MS
 *  (closed then). */
function opened(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`the socket did not open in ${SOCKET_OPEN_MS} ms`));
    }, SOCKET_OPEN_MS);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("the socket failed before it opened"));
      },
      { once: true },
    );
  });
}
