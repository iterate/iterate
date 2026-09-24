// perf/context-residency.perf.test.ts — CLOUDFLARE'S SIDE OF RESIDENCY, timed alone and OPT-IN. The
// e2e rows (e2e/context-residency.e2e.test.ts) assert what the platform code decides: the wakes, the
// resets a birth names on its wake record, and that a careless facet is no longer running once its
// quiet minute is up. What they cannot assert is what Cloudflare decides: that a loaded facet the
// context no longer holds keeps running after its context is evicted (the reason the sweep exists),
// that a context under outside traffic stays resident, that a claimed facet lives out its attempt.
// Under the e2e run — 16 files, their rows concurrent — those sampled the platform: 3 of 124 e2e jobs
// saw it stop a facet 0 s and 20 s after its call, stop a claimed facet mid-attempt, and evict a
// context mid-traffic while the control plane stalled 12.8 s (#2899, #2921, #2939), each green on
// its retry.
//
// OPT-IN, the crash hunt's way (e2e/isolate-ceilings-deployed.e2e.test.ts): `RUN_RESIDENCY_TIMING=1`,
// or the soak's `residency-timing` input (.depot/workflows/os-e2e-soak.yml), which runs them after
// every e2e run. The latency guard (.depot/workflows/os-latency.yml) runs this suite every 3 hours and
// reads any row that fails for anything but a budget as a broken probe; these rows sample the
// platform, so they stay out of it. Unlike the budgets beside them, they run CONCURRENTLY with each
// other: they measure how long an actor lives, not how fast a call is, and in order they would take
// eleven minutes. Each prints what it measured.

import { expect, test } from "vitest";
import {
  disposeSessions,
  freshCtx,
  openItx,
  readAll,
  sleep,
  until,
} from "../e2e/support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  projectHostsAreLocal,
  projectUrl,
  publishConfigWorker,
  registerProject,
} from "../e2e/support/project-host.ts";
import {
  CHATTY_SOURCE,
  facetStartedAt,
  HEARTBEAT_SOURCE,
  RELEASER_SOURCE,
  SITE_SOURCE,
  SLEEPER_SOURCE,
} from "../e2e/support/residency-facets.ts";

const optedIn = process.env.RUN_RESIDENCY_TIMING === "1";
const timed = test.skipIf(!optedIn);
/** A project host's row: only a real deployment routes one (support/project-host.ts `deployedOnly`). */
const timedDeployed = test.skipIf(!optedIn || projectHostsAreLocal());

timed.concurrent(
  "a careless loaded facet outlives its evicted context until the sweep stops it a quiet minute after the last call",
  async () => {
    const ctx = freshCtx("residency_sweep_timed");
    const heartbeat = (method: string) =>
      openItx(ctx).invoke([
        "itx",
        "facets",
        ["get", "heartbeat", { source: HEARTBEAT_SOURCE, className: "HeartbeatDurableObject" }],
        [method],
      ]);
    const lastCallAt = await heartbeat("beat");
    disposeSessions();
    await sleep(110_000); // no request: the context evicts in ~10 s; the sweep's alarm is its only wake
    const record = await heartbeat("beats");
    const ranMs = record.lastBeat - lastCallAt;
    console.log(`[sweep] the careless facet beat ${record.beats} times over ${ranMs} ms`, record);
    // It beat on after its context evicted (~10 s), and stopped at the sweep (~60 s).
    expect(ranMs, JSON.stringify(record)).toBeGreaterThan(30_000);
    expect(ranMs, JSON.stringify(record)).toBeLessThan(90_000);
  },
  180_000,
);

timed.concurrent(
  "a careless loaded facet calling its own context every 5 s chatters past the eviction a birth would have needed, until the sweep resets it in place",
  async () => {
    const ctx = freshCtx("residency_chatty_timed");
    await openItx(ctx).invoke([
      "itx",
      "facets",
      ["get", "chatty", { source: CHATTY_SOURCE, className: "ChattyDurableObject" }],
      ["chatter"],
    ]);
    disposeSessions();
    await sleep(120_000); // no outside call: the facet's own appends are the context's only callers
    const chatter = (await readAll(openItx(ctx)))
      .filter((e: any) => e.type === "chatter")
      .map((e: any) => Date.parse(e.createdAt));
    const ranMs = chatter.at(-1)! - chatter[0]!;
    console.log(`[chatty] ${chatter.length} appends over ${ranMs} ms`);
    expect(ranMs, JSON.stringify(chatter)).toBeGreaterThan(40_000);
    expect(ranMs, JSON.stringify(chatter)).toBeLessThan(90_000);
  },
  180_000,
);

timed.concurrent(
  "a careless facet whose claim ends beats on through the sweep that ran while the claim held it, and stops a quiet minute after the release",
  async () => {
    const ctx = freshCtx("residency_released_timed");
    const releaser = (method: string, ...args: unknown[]) =>
      openItx(ctx).invoke([
        "itx",
        "facets",
        ["get", "releaser", { source: RELEASER_SOURCE, className: "ReleaserDurableObject" }],
        [method, ...args],
      ]);
    await releaser("start", 70_000);
    disposeSessions();
    await sleep(180_000); // nothing from here: the sweep runs at ~60 s, the release lands at 70 s
    const { lastBeat, releasedAt } = await releaser("beats");
    console.log(`[released] beat on ${lastBeat - releasedAt} ms after the release`);
    expect(lastBeat - releasedAt, JSON.stringify({ lastBeat, releasedAt })).toBeGreaterThan(30_000);
    expect(lastBeat - releasedAt, JSON.stringify({ lastBeat, releasedAt })).toBeLessThan(90_000);
  },
  270_000,
);

// A PROJECT HOST'S HTTP is outside activity: every request restarts the sweep's quiet clock, so a
// loaded facet serving one every 5 s is never reset in place — and a context reached every 5 s is
// never evicted, so no birth resets it either. The second half is Cloudflare's, and the reason this
// row is timed here: under the e2e run the control plane stalled 12.8 s, the requests stopped
// reaching the context for 16 s, and the next one's birth reset the facet (#2899).
timedDeployed.concurrent(
  "a loaded facet serving outside HTTP requests every 5 s is the same instance throughout",
  async () => {
    const slug = freshDnsSafeProjectSlug("residency-site-timed");
    const projectId = await registerProject(slug);
    await publishConfigWorker(openItx(projectId), [
      "itx",
      "facets",
      ["get", "site", { source: SITE_SOURCE, className: "SiteDurableObject" }],
    ]);
    const answers: { at: number; ms: number; instance: string }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 150_000) {
      const sentAt = Date.now();
      const page = await fetchProjectUrl(projectUrl({ project: slug, routingSlug: "site" }));
      expect(page).toMatchObject({ status: 200 });
      answers.push({ at: sentAt - t0, ms: Date.now() - sentAt, instance: page.text });
      await sleep(5_000);
    }
    const instances = [...new Set(answers.map((a) => a.instance))];
    console.log(
      `[site] ${answers.length} requests, ${instances.length} instance(s), slowest ${Math.max(...answers.map((a) => a.ms))} ms`,
    );
    expect(instances, JSON.stringify(answers)).toHaveLength(1);
  },
  240_000,
);

timed.concurrent(
  "a facet's claimed background work finishes on the instance that started it across its context's incarnations",
  async () => {
    const ctx = freshCtx("residency_claimed_timed");
    const itx = openItx(ctx);
    await itx.processors.enable("sleeper", {
      source: SLEEPER_SOURCE,
      className: "SleeperDurableObject",
    });
    const started = await facetStartedAt(itx.facets.get("sleeper"));
    const [sleep45] = await itx.append({ type: "sleep", payload: { ms: 45_000 } });
    disposeSessions();
    await sleep(60_000); // no request meanwhile: a poll would keep the context resident
    const slept = await until(
      "the background sleep's append",
      async () => (await readAll(openItx(ctx))).find((e: any) => e.type === "slept"),
      30_000,
    );
    const woken = (await readAll(openItx(ctx))).filter(
      (e: any) =>
        e.type === "events.iterate.com/stream/woken" &&
        e.offset > sleep45.offset &&
        e.offset < slept.offset,
    );
    console.log(
      `[claimed] ${woken.length} wake(s) mid-sleep; slept on the instance started ${slept.payload.startedAt - started} ms after the first`,
    );
    // The claim's alarm woke the context mid-sleep (20 s in; the revive's next claim falls due after
    // the append), and the append came from the instance the sleep started on.
    expect(woken.length, JSON.stringify(woken)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(slept.payload.startedAt - started)).toBeLessThan(5_000);
  },
  150_000,
);
