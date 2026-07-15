// Eviction recovery for the github-agent processor (codex review P1): a
// trusted mention's consequential work — the collaborator verification and
// the agent-message append — runs under `blockProcessorWhile`, so a lone
// agent-DO death holds the cursor and the subscription spine redelivers.
// What the spine CANNOT cover is the SIMULTANEOUS Agent+Stream DO death (a
// deploy evicts both) during a verification at raw head: nothing is armed to
// dial either side again, and the mention strands indefinitely. Per-runner
// recovery closes that — the durable alarm survives the death, its revival
// appends the core `stream/processor-revived` fact (in production the append cold-boots the
// Stream DO, whose `woken` fan-out restores the spine), and the ordinary
// redelivery of the UNACKNOWLEDGED frame re-runs the verification and the
// turn append.
//
// The processor is driven the way production drives it: a REAL
// createStreamProcessorRegistry (runner + durableObjectRecovery + keepalive
// alarm) over a fake DurableObjectState, the in-memory MemoryStream journal,
// and a virtual clock — the same harness shape as repo-recovery.test.ts.
// `crash()` is an eviction: in-flight work dies; the journal, KV progress,
// and the durable alarm survive.

import { describe, expect, it } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS } from "../streams/stream-processor-keepalive.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "../streams/stream-processor-registry.ts";
import { STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "../streams/core-processor-contract.ts";
import { GITHUB_LINK, pullRequestBody, webhookPayload } from "./github-agent-test-helpers.ts";
import { GithubAgentProcessorContract } from "./github-agent-processor-contract.ts";
import { GithubAgentProcessor } from "./github-agent-processor-implementation.ts";
import { githubAgentPath } from "./github-agent-utils.ts";

const HOME = await githubAgentPath({ ...GITHUB_LINK, repoPath: "/repos/config" }, 7);
const SLUG = GithubAgentProcessorContract.slug;

const ROUTE_EVENT = {
  type: "events.iterate.com/github-agent/route-configured" as const,
  payload: { ...GITHUB_LINK, number: 7, repoPath: "/repos/config", streamPath: HOME },
};

/** An inconclusive-association mention — the trigger whose trust needs the
 * async collaborator verification under the blocker. */
const MENTION_EVENT = {
  type: "events.iterate.com/github/webhook-received" as const,
  payload: webhookPayload(
    pullRequestBody({
      comment: {
        authorAssociation: "NONE",
        body: "@iterate what does this change do?",
        senderLogin: "trusted-but-unclassified",
      },
    }),
    "issue_comment",
  ),
};

function makeHarness() {
  const clock = { now: Date.parse("2026-07-15T12:00:00Z") };
  const stream = new MemoryStream(HOME);
  stream.now = () => clock.now;

  const kv = new Map<string, unknown>();
  const alarm: { at: number | null } = { at: null };
  let pending: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      kv: {
        get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
        put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: (key: string) => kv.delete(key),
      },
      getAlarm: async () => alarm.at,
      setAlarm: async (at: number | Date) => {
        alarm.at = typeof at === "number" ? at : at.getTime();
      },
      deleteAlarm: async () => {
        alarm.at = null;
      },
    },
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise.catch(() => undefined)),
  } as unknown as DurableObjectState;

  /** Per-incarnation collaborator check; tests reassign `impl` across
   * crashes. The default throws, so "must not verify in this scenario" is the
   * resting state. */
  const verify: { impl: (input: unknown) => Promise<boolean> } = {
    impl: () => {
      throw new Error("must not verify in this scenario");
    },
  };

  let registry!: StreamProcessorRegistry;
  const boot = () => {
    registry = createStreamProcessorRegistry(ctx, {
      stream,
      path: HOME,
      projectId: null,
      version: "v-test",
      now: () => clock.now,
    });
    registry.register(
      new GithubAgentProcessor({
        stream,
        path: HOME,
        projectId: null,
        isRepositoryCollaborator: (input) => verify.impl(input),
        now: () => clock.now,
      }),
      { recovery: true },
    );
  };
  boot();

  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const head = () => stream.events.at(-1)?.offset ?? 0;

  const harness = {
    clock,
    stream,
    kv,
    alarm,
    verify,
    settle,
    head,
    get registry() {
      return registry;
    },
    /** Evict the incarnation: registry, runner, and the in-flight
     * verification die; the journal, KV progress, and the durable alarm
     * survive. */
    crash() {
      pending = [];
      boot();
    },
    async wake() {
      return await registry.wakeStreamSubscriber({
        stream: { projectId: null, path: HOME, streamMaxOffset: head() },
        subscriptionKey: "wake:github-agent",
        processorSlug: SLUG,
      });
    },
    /** Wake and push everything past the acknowledged cursor as one frame —
     * the transport's job, minimally. */
    async deliverPending() {
      const woken = await harness.wake();
      const events = stream.events.filter((event) => event.offset > woken.checkpointOffset);
      if (events.length > 0) {
        await woken.sink({
          projectId: null,
          path: HOME,
          events,
          streamMaxOffset: head(),
          state: null,
        });
      }
      await settle();
      return woken;
    },
    /** Advance virtual time, firing the durable alarm through the REAL
     * handleAlarm path whenever it comes due within the window. */
    async advance(ms: number) {
      const target = clock.now + ms;
      while (alarm.at !== null && alarm.at <= target) {
        clock.now = Math.max(clock.now, alarm.at);
        alarm.at = null; // the platform consumes the alarm by firing it
        await registry.handleAlarm();
        await settle();
      }
      clock.now = target;
    },
  };
  return harness;
}

describe("eviction recovery end to end", () => {
  it("died mid-verification → keepalive alarm → exactly one stream/processor-revived → the unacked frame redelivers → the verification and turn re-run", async () => {
    const h = makeHarness();
    // Incarnation 1 HANGS inside the collaborator check: the frame is blocked
    // in the mention's trust verification, the attempt rides the keepalive,
    // the revival alarm is armed, and the cursor is held BEFORE the mention.
    // The frame never resolves — do not await it.
    h.verify.impl = () => new Promise<never>(() => {});
    await h.stream.append(ROUTE_EVENT, MENTION_EVENT);
    const woken = await h.wake();
    void Promise.resolve(
      woken.sink({
        projectId: null,
        path: HOME,
        events: h.stream.events.filter((event) => event.offset > woken.checkpointOffset),
        streamMaxOffset: h.head(),
        state: null,
      }),
    ).catch(() => undefined);
    await h.settle();
    expect(h.alarm.at).not.toBeNull();
    expect(
      h.stream.events.some(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { role?: unknown }).role === "developer",
      ),
    ).toBe(false);

    h.crash(); // the in-flight verification dies; journal, KV, and the alarm survive
    const checks: unknown[] = [];
    h.verify.impl = async (input) => {
      checks.push(input);
      return true;
    };
    await h.advance(KEEPALIVE_ALARM_LEAD_MS + 1);

    // durableObjectRecovery's revival pass journaled the processor-scoped
    // fact — in production its append cold-boots the Stream DO, whose woken
    // fan-out drives the redelivery simulated below.
    const revived = h.stream.events.filter(
      (event) => event.type === STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
    );
    expect(revived).toHaveLength(1);
    expect(revived[0]!.payload).toMatchObject({
      processorSlug: SLUG,
      revivals: 1,
      version: "v-test",
    });

    // The redelivery re-runs the blocking work from the held cursor: the
    // collaborator check runs again, the durable verification fact and the
    // trusted turn both land.
    await h.deliverPending();
    expect(checks).toEqual([
      {
        connection: "install-789",
        login: "trusted-but-unclassified",
        owner: "acme",
        repo: "widgets",
      },
    ]);
    expect(
      h.stream.events.filter(
        (event) =>
          event.type === "events.iterate.com/github-agent/repository-collaborator-verified",
      ),
    ).toHaveLength(1);
    const turns = h.stream.events.filter(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        (event.payload as { role?: unknown }).role === "developer",
    );
    expect(turns).toHaveLength(1);
    expect((turns[0]!.payload as { content: string }).content).toContain(
      "trustedInstructionSource: true",
    );

    // Idempotency-keyed appends settle the mention for good.
    await h.deliverPending();
    expect(
      h.stream.events.filter(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          (event.payload as { role?: unknown }).role === "developer",
      ),
    ).toHaveLength(1);
  });
});
