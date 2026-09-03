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
//    leaves first, and tolerates exactly ONE `woken` per stream stamped after
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
import { installResilientAiInterceptor } from "@iterate-com/shared/test-support/resilient-ai-interceptor";
import { createTestProject } from "../test-support/create-test-project.ts";
import { createAdminOsItx } from "../test-support/os-client.ts";
import { deployedBaseUrl } from "./test-helpers.ts";

const QUIET_SECONDS = Number(process.env.ABANDONED_PROJECT_QUIET_SECONDS || 90);
const WOKEN = "events.iterate.com/stream/woken";

// Everything fits under the heavy-test ceiling (E2E_HEAVY_TEST_TIMEOUT_MS,
// 240s, guarded by scripts/preview/e2e-policy.test.ts): ~30s of setup (the
// intercepted turn settles in well under a second; the first-turn worker
// build is the slow part), 15s of settling, the 90s quiet window, two read
// passes. Raising ABANDONED_PROJECT_QUIET_SECONDS past ~120 needs the
// ceiling raised by hand — the pin's own deadline must stay below it.
const failWakeUp = failing(
  test.skipIf(deployedBaseUrl() === null),
  /woke \d+ times after dispose/,
  {
    timeoutMs: 200_000,
  },
);

failWakeUp(
  "a disposed test project stops waking its Durable Objects",
  { timeout: 240_000 },
  async () => {
    // Everything the "test" holds open lives in this block, so leaving it IS
    // the test ending: the fixture (its disposer is the thing a real teardown
    // hangs off), the interceptor's dedicated session and reconnect loop, and
    // the agent handle are all released by `using` whether the turn succeeded
    // or threw. Only what the measurement needs escapes.
    let project: { id: string; slug: string; baseUrl: string };
    let baseline: Map<string, number>;
    {
      await using handle = await createTestProject({ slugPrefix: "abandoned" });
      using itx = handle.itx();
      project = { ...handle.project, baseUrl: handle.baseUrl };
      // One real agent turn against a scripted model — the shape every spec
      // leaves behind. The reply is asserted so the test cannot pass vacuously
      // by never having created the work it claims to abandon. The agent runs
      // codemode: a reply is a script, and only a script that calls the chat
      // produces the `web-message-sent` that `ask()` waits for (same shape as
      // specs/agent-fake-model-chat.spec.ts). The interceptor rides the shared
      // churn-surviving loop, so a DO restart mid-turn re-installs it instead
      // of failing the test for a reason that proves nothing about the pin.
      await using _interception = await installResilientAiInterceptor({
        projectId: handle.project.id,
        connect: (options) => createAdminOsItx({ baseUrl: handle.baseUrl, ...options }),
        handler: async () =>
          [
            "```ts",
            `async (itx) => {\n  await itx.chat.sendMessage("scripted reply")\n}`,
            "```",
          ].join("\n"),
      });
      using agent = handle.agent("/agents/abandoned");
      await agent.create();
      await agent.append({
        type: "events.iterate.com/agent/configured",
        payload: { config: { llm: { model: "intercepted/scripted" } } },
      });
      // The first turn also waits on the project worker's first build.
      const reply = await agent.ask({ message: "hello", timeoutMs: 60_000 });
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
      baseline = await readOffsets(itx);
    }

    await sleep(QUIET_SECONDS * 1000);

    // A fresh admin session for the measurement: none of the test's own
    // connections survive the block above.
    using itx = createAdminOsItx({ baseUrl: project.baseUrl, context: project.id });
    // The measurement. Leaves first so a parent's boot cannot cascade into a
    // child that is read after it.
    const readStart = Date.now();
    // Tallied by stream + event type: what woke, how often, when.
    const woke: Record<
      string,
      { path: string; type: string; count: number; first: string; last: string }
    > = {};
    const paths = (await itx.streams.list()).map((stream) => stream.path);
    paths.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
    for (const path of paths) {
      const since = baseline.get(path);
      if (since === undefined) {
        woke[path] = {
          path,
          type: "(stream created after dispose)",
          count: 1,
          first: "",
          last: "",
        };
        continue;
      }
      const events = await itx.streams.get(path).getEvents({ afterOffset: since });
      // This read booted the stream, which appended exactly one `woken` after
      // readStart. Drop that one; any other late `woken` is a real wake.
      const ourBoot = events.findIndex(
        (event) => event.type === WOKEN && Date.parse(event.createdAt) >= readStart - 1_000,
      );
      const withoutOurBoot = events.filter((_, index) => index !== ourBoot);
      for (const event of withoutOurBoot) {
        const key = `${path} ${event.type}`;
        woke[key] ||= {
          path,
          type: event.type,
          count: 0,
          first: event.createdAt,
          last: event.createdAt,
        };
        woke[key].count += 1;
        woke[key].last = event.createdAt;
      }
    }

    const total = Object.values(woke).reduce((sum, row) => sum + row.count, 0);
    const message = `project ${project.slug} should be quiet after dispose (${QUIET_SECONDS}s), but it woke ${total} times after dispose`;
    // The expected-fail reporter prints nothing for a pinned failure, so the
    // evidence goes to the log by hand.
    console.log(woke);
    expect(woke, message).toEqual({});
  },
);

// ---------------------------------------------------------------------------

async function readOffsets(itx: ReturnType<Awaited<ReturnType<typeof createTestProject>>["itx"]>) {
  const offsets = new Map<string, number>();
  const paths = (await itx.streams.list()).map((stream) => stream.path);
  // Leaves first, same order as the final read pass.
  paths.sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  for (const path of paths) {
    offsets.set(path, (await itx.streams.get(path).getEventPage({ limit: 1 })).streamMaxOffset);
  }
  return offsets;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
