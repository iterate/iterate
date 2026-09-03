// Pinned bug (tasks/abandoned-project-goes-quiet.md, the 2026-09-01→02 DO
// duration runaway): a test project that has been disposed keeps waking its
// Durable Objects — the config template's heartbeat schedule fires forever,
// and stream alarm loops keep re-arming — so every preview e2e run leaves a
// population of billable DOs behind (~4,500 DO-hours in 90 minutes from one
// deploy + e2e on 2026-09-02). Today `createTestProject`'s disposer is a
// no-op (test-support/create-test-project.ts) because itx has no project
// removal; when teardown lands this test flips to passing and the `failing`
// wrapper comes off.
//
// The measurement has two traps, both handled below:
//  - Reading a stream boots it, and the boot appends `stream/woken` before
//    serving the read. So the final pass reads each stream exactly once,
//    leaves first, and tolerates only ONE `woken` per stream stamped after
//    the pass began. Anything else is a wake we did not cause.
//  - The template's heartbeat is 15 minutes. Waiting 16 minutes is not a
//    test, so an extra 5-second heartbeat is installed on the scheduler; a
//    surviving scheduler shows up as `trigger-requested` events within the
//    90-second quiet window.
//
// Run against a preview (it leaves a project behind on purpose):
//   doppler run --config preview_N -- pnpm --dir apps/os e2e --run abandoned-project-goes-quiet
import { expect, test } from "vitest";
import { failing } from "@iterate-com/shared/test-support/failing-test";
import type { StreamEvent } from "../../src/itx-api.generated.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { deployedBaseUrl } from "./test-helpers.ts";

const QUIET_SECONDS = Number(process.env.ABANDONED_PROJECT_QUIET_SECONDS || 90);
const WOKEN = "events.iterate.com/stream/woken";

// Budget: first-turn worker build + ask under preview load (up to ~3 min, see
// agent-tools.itx.e2e.test.ts) + the quiet window + the read passes.
const SETUP_BUDGET_MS = 240_000;
const goesQuiet = failing(test.skipIf(deployedBaseUrl() === null), /woke \d+ times after dispose/, {
  timeoutMs: QUIET_SECONDS * 1000 + SETUP_BUDGET_MS,
});

goesQuiet(
  "a disposed test project stops waking its Durable Objects",
  { timeout: QUIET_SECONDS * 1000 + SETUP_BUDGET_MS + 30_000 },
  async () => {
    const handle = await createTestProject({ slugPrefix: "abandoned" });
    using itx = handle.itx();

    // One real agent turn against a scripted model — the shape every spec
    // leaves behind. The reply is asserted so the test cannot pass vacuously
    // by never having created the work it claims to abandon.
    // The agent runs codemode: a reply is a script, and only a script that
    // calls the chat produces the `web-message-sent` that `ask()` waits for
    // (same shape as specs/agent-fake-model-chat.spec.ts).
    using interception = await itx.ai.intercept(async () =>
      ["```ts", `async (itx) => {\n  await itx.chat.sendMessage("scripted reply")\n}`, "```"].join(
        "\n",
      ),
    );
    using agent = handle.agent("/agents/abandoned");
    await agent.create();
    await agent.append({
      type: "events.iterate.com/agent/configured",
      payload: { config: { llm: { model: "intercepted/scripted" } } },
    });
    // The first turn also waits on the project worker's first build; well past the
    // 45s default under preview load (agent-tools.itx.e2e.test.ts measured it).
    const reply = await agent.ask({ message: "hello", timeoutMs: 180_000 });
    expect(reply, "the agent turn should complete before the project is abandoned").toBeTruthy();

    // The template's heartbeat fires every 15 minutes; a proper teardown must
    // stop the scheduler, so give it something to fire within the window.
    await itx.scheduler.set({
      key: "e2e/abandoned-heartbeat",
      recurrence: { every: 5 },
      script: `async (itx, schedule, trigger) => {
        await itx.streams.get("/").append({
          type: "events.iterate.com/project/heartbeat-triggered",
          idempotencyKey: "e2e/abandoned-heartbeat:" + trigger.executionId,
          payload: { scheduleKey: schedule.key },
        });
      }`,
    });

    // Let the turn's own deliveries and the first heartbeat land, then take
    // the baseline. The baseline reads boot every stream; a second short
    // settle lets that cascade finish before the offsets are recorded.
    await sleep(10_000);
    await readOffsets(itx);
    await sleep(5_000);
    const baseline = await readOffsets(itx);

    // Abandon it the way every test does.
    await interception.release();
    await handle[Symbol.asyncDispose]();

    await sleep(QUIET_SECONDS * 1000);

    // The measurement. Leaves first so a parent's boot cannot cascade into a
    // child that is read after it.
    const readStart = Date.now();
    const rows: WakeRow[] = [];
    const afterPaths = (await itx.streams.list()).map((stream) => stream.path);
    for (const path of afterPaths.sort(leavesFirst)) {
      const since = baseline.get(path);
      if (since === undefined) {
        rows.push({ path, type: "(stream created after dispose)", count: 1, first: "", last: "" });
        continue;
      }
      const events = await itx.streams.get(path).getEvents({ afterOffset: since });
      for (const row of summarize(
        path,
        events.filter((event) => !isOurOwnBoot(event, readStart)),
      )) {
        rows.push(row);
      }
    }

    const total = rows.reduce((sum, row) => sum + row.count, 0);
    // The table is the evidence; the expected-fail summary swallows the
    // assertion message, so print it where CI logs keep it.
    if (rows.length > 0)
      console.error(
        `[abandoned-project] ${handle.project.slug} woke after dispose:\n${table(rows)}`,
      );
    expect(
      rows,
      `project ${handle.project.slug} should be quiet after dispose (${QUIET_SECONDS}s), but it woke ${total} times after dispose:\n${table(rows)}`,
    ).toEqual([]);
  },
);

// ---------------------------------------------------------------------------

type WakeRow = { path: string; type: string; count: number; first: string; last: string };

async function readOffsets(itx: ReturnType<Awaited<ReturnType<typeof createTestProject>>["itx"]>) {
  const offsets = new Map<string, number>();
  const streams = await itx.streams.list();
  for (const stream of streams.map((s) => s.path).sort(leavesFirst)) {
    offsets.set(stream, (await itx.streams.get(stream).getEventPage({ limit: 1 })).streamMaxOffset);
  }
  return offsets;
}

/** The one event the final read pass itself manufactures: a boot's `woken`. */
function isOurOwnBoot(event: StreamEvent, readStart: number) {
  return event.type === WOKEN && Date.parse(event.createdAt) >= readStart - 1_000;
}

function summarize(path: string, events: StreamEvent[]): WakeRow[] {
  const byType = new Map<string, StreamEvent[]>();
  for (const event of events) byType.set(event.type, [...(byType.get(event.type) || []), event]);
  return [...byType.entries()].map(([type, group]) => ({
    path,
    type,
    count: group.length,
    first: group[0]!.createdAt,
    last: group.at(-1)!.createdAt,
  }));
}

function table(rows: WakeRow[]) {
  const header = "path | event type | count | first | last";
  return [
    header,
    ...rows.map((r) => `${r.path} | ${r.type} | ${r.count} | ${r.first} | ${r.last}`),
  ].join("\n");
}

/** Deeper paths first, so `/agents/x` is read before `/agents` before `/`. */
function leavesFirst(a: string, b: string) {
  return b.split("/").length - a.split("/").length || a.localeCompare(b);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
