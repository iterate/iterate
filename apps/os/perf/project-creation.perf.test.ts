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
// or whose create threw, counts as READY_DEADLINE_MS: a creation that stalls or fails under load is
// the slowness this guards, never a broken probe.

import { test } from "vitest";
import { adminCredentials, session, sleep } from "../e2e/support/client.ts";
import { freshDnsSafeProjectSlug } from "../e2e/support/project-host.ts";
import type { LatencyMetricName } from "./latency.ts";
import { recordLatency } from "./record.ts";

const READY_DEADLINE_MS = 60_000;

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
 *  sample is at most one poll and one round trip late). A throw or a miss of the deadline answers
 *  the deadline, with the reason. */
async function createProject(prefix: string) {
  const slug = freshDnsSafeProjectSlug(prefix);
  const started = performance.now();
  let answeredMs = READY_DEADLINE_MS;
  try {
    const itx = await session()
      .authenticate(adminCredentials({ email: `${slug}@example.com` }))
      .projects.create({ project: slug });
    answeredMs = performance.now() - started;
    for (let after = 0; performance.now() - started < READY_DEADLINE_MS; await sleep(100)) {
      const page = await itx.invoke(["itx", ["readEvents", after, 100]]);
      if (
        page.events.some((e: { type: string }) => e.type === "events.iterate.com/project/created")
      )
        return { answeredMs, readyMs: performance.now() - started };
      after = page.scannedThroughOffset;
    }
    return { answeredMs, readyMs: READY_DEADLINE_MS, error: `${slug}: not ready in time` };
  } catch (error) {
    return { answeredMs, readyMs: READY_DEADLINE_MS, error: `${slug}: ${String(error)}` };
  }
}
