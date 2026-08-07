// The chat-reply push producer's executable spec, on the generic step harness
// from iterate/processors/testing: the REAL StreamProcessorRunner over a
// MemoryStreamNetwork (the agent stream the processor runs on, plus the
// project root stream its intents land on), virtual time, production
// idempotency semantics.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { ChatReplyNotifyProcessorContract } from "./chat-reply-notify-contract.ts";
import { ChatReplyNotifyProcessor } from "./chat-reply-notify-implementation.ts";

type ChatReplyNotifyEventInput = ConsumedInput<ChatReplyNotifyProcessorContract>;

const T0 = Date.parse("2026-07-19T08:00:00Z");
const AGENT_PATH = "/agents/mobile/1752825600000";
const INTENT = "events.iterate.com/notification/requested";

const CREATED = {
  type: "events.iterate.com/chat-reply-notify/created",
  payload: { config: {} },
} satisfies ChatReplyNotifyEventInput;

function userMessage(overrides?: { content?: string; userId?: string | undefined }) {
  return {
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "user",
      content: overrides?.content ?? "Find me a cheap flight to Lisbon",
      actor: {
        type: "user",
        origin: "web",
        ...(overrides ? { userId: overrides.userId } : { userId: "usr_misha" }),
      },
    },
  } satisfies ChatReplyNotifyEventInput;
}

function agentReply(message: string) {
  return {
    type: "events.iterate.com/agents/web-message-sent",
    payload: { message },
  } satisfies ChatReplyNotifyEventInput;
}

describe("ChatReplyNotifyProcessor", () => {
  it("a reply to a user turn becomes one user-addressed intent on the project root", async () => {
    const h = makeChatReplyHarness();
    await h.play([
      "append",
      CREATED,
      userMessage(),
      agentReply("Found 3 flights under $400 — the Tuesday red-eye is the best deal."),
    ]);

    expect(h.rootEvents()).toMatchObject([
      {
        type: INTENT,
        payload: {
          // The reply's own offset on THIS agent stream: the suppression
          // handle a project/agent-reply-presented claim matches against.
          agentReplyEventOffset: 3,
          audience: { kind: "user", userId: "usr_misha" },
          title: "Agent replied",
          body: "Found 3 flights under $400 — the Tuesday red-eye is the best deal.",
          destination: { kind: "agent-chat", path: AGENT_PATH },
          // One hour past the reply event's own commit time, never `now`.
          expiresAt: T0 + 60 * 60_000,
        },
      },
    ]);
  });

  it("markdown in the reply is flattened — push bodies can only render plain text", async () => {
    const h = makeChatReplyHarness();
    await h.play([
      "append",
      CREATED,
      userMessage({ content: "Answer geography question" }),
      agentReply("The capital of Germany is **[Berlin](https://en.wikipedia.org/wiki/Berlin)**"),
    ]);

    expect(h.rootEvents()).toMatchObject([
      { type: INTENT, payload: { body: "The capital of Germany is Berlin" } },
    ]);
  });

  it("a multi-message agent turn yields ONE push: only the reply that closes the turn notifies", async () => {
    const h = makeChatReplyHarness();
    await h.play([
      "append",
      CREATED,
      userMessage(),
      agentReply("Working on it…"),
      agentReply("Done! Booked the Tuesday red-eye."),
    ]);

    expect(h.rootEvents()).toMatchObject([
      { type: INTENT, payload: { agentReplyEventOffset: 3, body: "Working on it…" } },
    ]);
  });

  it("a fresh user message re-opens the turn, so the next reply notifies again", async () => {
    const h = makeChatReplyHarness();
    await h.play([
      "append",
      CREATED,
      userMessage(),
      agentReply("First answer"),
      userMessage({ content: "And hotels?" }),
      agentReply("Three good options near the river."),
    ]);

    expect(h.rootEvents().filter((event) => event.type === INTENT)).toHaveLength(2);
  });

  it("agent-authored context (delegation traffic) opens no turn and replies to it stay silent", async () => {
    const h = makeChatReplyHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "developer",
          content: "Report from the child agent",
          actor: { type: "agent", path: "/agents/researcher" },
        },
      },
      agentReply("Thanks, incorporating."),
    ]);

    expect(h.rootEvents()).toEqual([]);
  });

  it("uses the agent's summary title when set, and clears back to the fallback on null", async () => {
    const h = makeChatReplyHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: "events.iterate.com/agent/summary-updated",
        payload: { title: "Trip planner" },
      },
      userMessage(),
      agentReply("On it."),
    ]);
    expect(h.rootEvents().at(-1)).toMatchObject({ payload: { title: "Trip planner" } });

    await h.play([
      "append",
      { type: "events.iterate.com/agent/summary-updated", payload: { title: null } },
      userMessage(),
      agentReply("Anything else?"),
    ]);
    expect(h.rootEvents().at(-1)).toMatchObject({ payload: { title: "Agent replied" } });
  });

  it("a user message with no stamped identity still notifies, project-wide", async () => {
    const h = makeChatReplyHarness();
    await h.play(["append", CREATED, userMessage({ userId: undefined }), agentReply("Done.")]);

    expect(h.rootEvents()).toMatchObject([
      { type: INTENT, payload: { audience: { kind: "project" } } },
    ]);
  });

  it("a blank reply (files-only message) still yields a valid push body", async () => {
    const h = makeChatReplyHarness();
    await h.play(["append", CREATED, userMessage(), agentReply("   ")]);

    expect(h.rootEvents()).toMatchObject([{ type: INTENT, payload: { body: "Sent a reply." } }]);
  });

  it("a full replay (fresh cursor over the same streams) re-appends identical intents that dedupe on the key", async () => {
    const h = makeChatReplyHarness();
    await h.play(["append", CREATED, userMessage(), agentReply("Done.")], ["advanceTime", 60_000]);
    const committed = h.rootEvents().map((event) => event.offset);

    const replay = makeChatReplyHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(ChatReplyNotifyProcessorContract),
    });
    await replay.settle(); // replays the whole stream; a same-key conflict would throw here

    expect(replay.rootEvents().map((event) => event.offset)).toEqual(committed);
    expect(replay.rootEvents()).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

/** The generic harness on an agent stream, with the project root reachable so
 * appendTo("/") lands somewhere observable. */
function makeChatReplyHarness(substrateOverride?: HarnessSubstrate) {
  const substrate: HarnessSubstrate =
    substrateOverride ||
    (() => {
      const clock = { now: T0 };
      const network = new MemoryStreamNetwork(() => clock.now);
      return {
        clock,
        stream: network.get(AGENT_PATH),
        progress: makeMemoryProgressStore(ChatReplyNotifyProcessorContract),
      };
    })();
  const harness = makeProcessorHarness<ChatReplyNotifyProcessorContract, ChatReplyNotifyProcessor>({
    createProcessor: (deps) => new ChatReplyNotifyProcessor({ ...deps, projectId: "prj_test" }),
    substrate,
  });
  return {
    ...harness,
    rootEvents: () => harness.stream.network!.eventsAt("/"),
  };
}
