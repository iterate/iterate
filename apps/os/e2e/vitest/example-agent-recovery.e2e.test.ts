import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/processors";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Proves alarm-based recovery for a userspace processor hosted as a FACET —
// using the example that ships in the config-repo TEMPLATE
// (configs/default/apps/example-agent/example-agent.ts), so this test doubles
// as a check that the template a project is seeded with actually works.
//
// The example is a miniature agent: a prompt opens a "must reply" obligation,
// a slow background attempt produces the reply, and `recovery` is on. We run it
// as a facet, kill the Stream DO while the reply is still being generated, and
// prove the reply lands anyway — the only way it can, since the first attempt
// died with the incarnation, is the parent's keepalive alarm reviving the facet.

// Must match configs/default/apps/example-agent/example-agent.ts.
const PROMPT_RECEIVED = "events.example/agent/prompt-received";
const REPLY_PRODUCED = "events.example/agent/reply-produced";

test(
  "the template example-agent facet finishes its reply after the Stream DO is killed mid-generation",
  // Ceiling covering the two sequential waits below (cold build + revival) plus
  // setup. The expected run is ~60-90s — dominated by the one-time cold facet
  // build and the framework's ~10s keepalive lead, both irreducible.
  { timeout: 180_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`example-agent-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const streamPath = "/example-agent";
    const subscriptionName = "example-agent";
    const promptId = `prompt-${crypto.randomUUID().slice(0, 8)}`;

    const stream = project.streams.get(streamPath);

    // Host the TEMPLATE class as a facet of this stream's own Durable Object.
    // The source is the seeded config repo — nothing is committed here.
    const [subscription] = await stream.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        name: subscriptionName,
        receiver: {
          action: "facet-processor",
          source: {
            kind: "userspace",
            worker: {
              type: "stateful",
              path: streamPath,
              className: "ExampleAgent",
              durableWorkerKey: "example-agent",
              source: {
                createWorker: {
                  entryPoint: "apps/example-agent/example-agent.ts",
                  files: { type: "repo", repoPath: "/repos/config" },
                },
              },
            },
          },
        },
      },
    } satisfies StreamEventInput);

    // Open the obligation. This forces the cold facet build and wakes the
    // processor; a build failure would surface as a `subscription-delivery-halted`
    // event on the stream (read it if the wait below ever times out).
    const [prompt] = await stream.append({
      type: PROMPT_RECEIVED,
      payload: { id: promptId, text: "hello" },
    } satisfies StreamEventInput);
    if (!subscription || !prompt) {
      throw new Error("append returned no committed event");
    }

    // Barrier: the facet has consumed the prompt. Because the reply runs in the
    // background, the checkpoint advances past the prompt as soon as the attempt
    // STARTS — so once this resolves, the slow generation is in flight and the
    // parent's keepalive alarm is armed. The generous timeout covers the cold build.
    await stream.subscriptions
      .get(subscriptionName)
      .processor.waitUntilProcessed({ offset: prompt.offset, timeoutMs: 90_000 });

    // The kill only revives the work if the keepalive alarm is DURABLY armed on
    // the parent before we abort. The facet arms it over itx as its attempt
    // starts, but that hop can still be in flight when the checkpoint advances —
    // so wait for the parent to actually hold the alarm (through the same proxy
    // verb the facet uses) before killing. This is what makes the revival
    // deterministic rather than a race, and it directly exercises proxyGetAlarm.
    // (The arm is normally sub-second; were it ever slower than the 8s reply
    // generation, the next assertion would fail red — never a false pass.)
    await waitForCondition(async () => Number.isFinite(await stream.proxyGetAlarm()), {
      description: "the facet's keepalive to arm the parent's alarm over itx",
      timeoutMs: 30_000,
    });

    // Not replied yet: the generation is still running (and thus killable).
    expect(await replies()).not.toContain(promptId);

    // Kill the Stream DO mid-generation. This aborts the parent incarnation and
    // its facet, dropping the in-flight attempt. The durable alarm the keepalive
    // armed survives.
    await stream.kill().catch(() => undefined);

    // Revival: the platform fires the surviving alarm in a fresh incarnation,
    // which replays it into the reloaded facet's handleAlarm; recovery re-drives
    // the still-open obligation from the committed prompt and produces the reply.
    //
    // This is genuinely the alarm doing the work, not the poll below: each
    // `replies()` poll re-boots the parent Stream DO and appends a `stream/woken`
    // lifecycle event, but the example does NOT consume `woken`, so that suffix
    // is acked without waking the facet. Only the keepalive's `processor-revived`
    // fact wakes it. So the reply can appear by exactly one path — the alarm.
    await waitForCondition(async () => (await replies()).includes(promptId), {
      description: "the alarm to revive the killed facet and produce the reply",
      timeoutMs: 60_000,
    });

    // The processor's own committed fold reflects the settled obligation.
    const snapshot = await stream.subscriptions.get(subscriptionName).processor.snapshot();
    const state = snapshot.state as {
      replies: { id: string; reply: string }[];
      pending: { id: string }[];
    };
    expect(state.replies.map((entry) => entry.id)).toContain(promptId);
    expect(state.pending.map((entry) => entry.id)).not.toContain(promptId);

    async function replies(): Promise<string[]> {
      const events = await stream.getEvents({ eventTypes: [REPLY_PRODUCED] });
      return events.map((event) => (event.payload as { id: string }).id);
    }
  },
);
