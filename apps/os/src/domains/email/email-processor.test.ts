// The email thread router's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream (production idempotency semantics: a same-key append with a
// different body is REJECTED), with a MemoryStreamNetwork so the router's
// cross-stream forwards land on observable sibling streams. Scenarios are
// ordered steps — typed appends plus function steps for failure injection.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
} from "iterate/processors/testing";
import { EMAIL_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import { EmailProcessor } from "./email-processor-implementation.ts";
import { EmailProcessorContract, type InboundEmailPayload } from "./email-processor-contract.ts";

// -----------------------------------------------------------------------------
// Event literals: the router's birth and the recurring inbound-mail payload.
// These are event BUILDERS (data), not append wrappers — every test appends
// through the harness's typed append.
// -----------------------------------------------------------------------------

const ROUTER_BORN = {
  type: "events.iterate.com/email/created",
  payload: { config: {} },
} satisfies ConsumedInput<EmailProcessorContract>;

function receivedPayload(input: {
  from?: string;
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  subject?: string;
  text?: string;
  threadTag?: string | null;
  automated?: boolean;
}): InboundEmailPayload {
  return {
    envelope: { from: input.from ?? "jonas@example.com", to: "acme@iterate.app" },
    recipient: { slug: "acme", threadId: input.threadTag ?? null },
    projectId: "prj_1",
    automated: input.automated ?? false,
    message: {
      messageId: input.messageId ?? "msg-1@mail.example",
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? [],
      from: { address: input.from ?? "jonas@example.com", name: "Jonas" },
      replyToAddress: null,
      subject: input.subject ?? "Hello agent",
      text: input.text ?? "Can you help me with something?",
      attachments: [],
    },
  };
}

/** Every event the router's new-thread creation batch lands on the routed
 * stream, in order, ending with the route context and the forwarded mail. */
const ROUTED_CREATION_EVENT_TYPES = [
  "events.iterate.com/agent/created",
  "events.iterate.com/agent/binding-set",
  "events.iterate.com/capability-host/created",
  "events.iterate.com/email-agent/created",
  "events.iterate.com/agent/configured",
  "events.iterate.com/agents/context-added",
  "events.iterate.com/capability-host/capability-provided",
  "events.iterate.com/agents/context-added",
  "events.iterate.com/stream/subscription-configured",
  "events.iterate.com/stream/subscription-configured",
  "events.iterate.com/stream/subscription-configured",
  "events.iterate.com/stream/subscription-configured",
  "events.iterate.com/email/thread-route-configured",
  "events.iterate.com/email/received",
];

/** The generic harness over a MemoryStreamNetwork, so `appendTo` forwards are
 * observable. Pass another harness's substrate pieces (with a fresh progress
 * store) to replay the same stream from offset zero. */
function makeRouterHarness(substrate?: {
  clock: { now: number };
  network: MemoryStreamNetwork;
  progress: ReturnType<typeof makeMemoryProgressStore>;
}) {
  const clock = substrate?.clock ?? { now: Date.parse("2026-07-20T12:00:00.000Z") };
  const network = substrate?.network ?? new MemoryStreamNetwork(() => clock.now);
  const stream = network.get("/integrations/email");
  const harness = makeProcessorHarness<EmailProcessorContract>({
    createProcessor: (deps) =>
      new EmailProcessor({ stream: deps.stream, path: deps.path, projectId: "prj_1" }),
    substrate: {
      clock,
      stream,
      progress: substrate?.progress ?? makeMemoryProgressStore(EmailProcessorContract),
    },
  });
  return { ...harness, network };
}

describe("EmailProcessor (thread router)", () => {
  it("ignores a second email-router birth certificate during reduction", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ROUTER_BORN]);
    await h.append(ROUTER_BORN);
    expect(h.state().birthCertificate).toEqual(ROUTER_BORN.payload);
  });

  it("creates a thread route keyed by the received event's offset and forwards", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_BORN,
      { type: "events.iterate.com/email/received", payload: receivedPayload({}) },
    ]);

    // The birth certificate is offset 1, so the first received event owns
    // thread id 2.
    expect(h.events("events.iterate.com/email/thread-route-configured")).toMatchObject([
      {
        payload: {
          threadId: "2",
          streamPath: "/agents/email/t2",
          counterpart: "jonas@example.com",
          subject: "Hello agent",
        },
      },
    ]);

    // The routed stream is explicitly born and subscribed before its route
    // context and mail.
    const routed = h.network.eventsAt("/agents/email/t2");
    expect(routed.map((event) => event.type)).toEqual(ROUTED_CREATION_EVENT_TYPES);
    expect(routed[1]!.payload).toEqual({
      type: "email_thread",
      counterpart: "jonas@example.com",
      subject: "Hello agent",
      threadId: "2",
    });
    expect(routed[5]).toMatchObject({
      payload: {
        // The untagged email prompt parses to one "agent/system-prompt" section.
        segments: [{ key: "agent/system-prompt", content: EMAIL_AGENT_SYSTEM_PROMPT }],
        role: "system",
      },
    });
    expect(routed[13]!.payload).toEqual(receivedPayload({}));
    expect(h.state().threads).toEqual({ "2": "/agents/email/t2" });
    expect(h.state().threadByMessageId).toEqual({ "msg-1@mail.example": "2" });
  });

  it("routes a +t-tagged reply to the existing thread without a new route", async () => {
    const h = makeRouterHarness();
    await h.play(
      [
        "append",
        ROUTER_BORN,
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({ messageId: "msg-1@mail.example" }),
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({ threadTag: "2", messageId: "msg-2@mail.example" }),
        },
      ],
    );

    const routed = h.network
      .eventsAt("/agents/email/t2")
      .filter((event) => event.type === "events.iterate.com/email/received");
    expect(routed).toHaveLength(2);
    expect(h.events("events.iterate.com/email/thread-route-configured")).toHaveLength(1);
    // The reply's message id joined the thread index too.
    expect(h.state().threadByMessageId["msg-2@mail.example"]).toBe("2");
  });

  it("routes an untagged reply via In-Reply-To/References to the existing thread", async () => {
    const h = makeRouterHarness();
    await h.play(
      [
        "append",
        ROUTER_BORN,
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({ messageId: "msg-1@mail.example" }),
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({
            messageId: "msg-2@mail.example",
            inReplyTo: "msg-1@mail.example",
            references: ["msg-1@mail.example"],
          }),
        },
      ],
    );

    expect(
      h.network
        .eventsAt("/agents/email/t2")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
    expect(h.network.streams.has("/agents/email/t3")).toBe(false);
  });

  it("routes replies to the agent's own outbound mail via the email/sent index", async () => {
    const h = makeRouterHarness();
    await h.play(
      [
        "append",
        ROUTER_BORN,
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({ messageId: "msg-1@mail.example" }),
        },
        // The agent replied inside thread 2; the audit fact carries threadId.
        {
          type: "events.iterate.com/email/sent",
          payload: {
            from: "acme@iterate.app",
            messageId: "out-1@iterate.app",
            projectId: "prj_1",
            subject: "Re: Hello agent",
            to: "jonas@example.com",
            threadId: "2",
          },
        },
      ],
      // The human replies to the agent's mail — In-Reply-To names OUR
      // outbound message id, not theirs, and no +t tag survived.
      [
        "append",
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({
            messageId: "msg-3@mail.example",
            inReplyTo: "out-1@iterate.app",
          }),
        },
      ],
    );

    expect(
      h.network
        .eventsAt("/agents/email/t2")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
  });

  it("reduces sender-allowed patterns into the project allowlist, deduped and case-insensitive", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_BORN,
      {
        type: "events.iterate.com/email/sender-allowed",
        payload: { pattern: "Jonas@Example.com", reason: "project-owner" },
      },
      {
        type: "events.iterate.com/email/sender-allowed",
        payload: { pattern: "jonas@example.com" },
      },
      {
        type: "events.iterate.com/email/sender-allowed",
        payload: { pattern: "*@iterate.com" },
      },
    ]);

    expect(h.state().allowedSenders).toEqual(["jonas@example.com", "*@iterate.com"]);
  });

  it("forwards replies to agent-initiated threads to the SENDING agent's stream", async () => {
    // An agent-scoped itx.email.send binds its conversation to the calling
    // agent: it appends this route event (streamPath = the agent's own path,
    // NOT /agents/email/**) and a sent audit fact carrying the threadId.
    const h = makeRouterHarness();
    await h.play(
      [
        "append",
        ROUTER_BORN,
        {
          type: "events.iterate.com/email/thread-route-configured",
          payload: {
            threadId: "a1b2c3d4e5f6",
            streamPath: "/agents/slack/conn/c123/ts-1",
            counterpart: "jonas@example.com",
          },
        },
        {
          type: "events.iterate.com/email/sent",
          payload: {
            from: "acme@iterate.app",
            messageId: "out-slack-1@iterate.app",
            projectId: "prj_1",
            subject: "Report you asked for",
            to: "jonas@example.com",
            threadId: "a1b2c3d4e5f6",
          },
        },
      ],
      // Reply via the +t token…
      [
        "append",
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({
            threadTag: "a1b2c3d4e5f6",
            messageId: "reply-1@mail.example",
          }),
        },
      ],
      // …and a header-only reply to the bare address (In-Reply-To = OUR id).
      [
        "append",
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({
            messageId: "reply-2@mail.example",
            inReplyTo: "out-slack-1@iterate.app",
          }),
        },
      ],
    );

    const forwarded = h.network
      .eventsAt("/agents/slack/conn/c123/ts-1")
      .filter((event) => event.type === "events.iterate.com/email/received");
    expect(forwarded).toHaveLength(2);
    // No stray /agents/email/t<n> threads were minted for either reply.
    expect([...h.network.streams.keys()].filter((p) => p.startsWith("/agents/email/"))).toEqual([]);
  });

  it("starts a new thread when an unknown +t tag arrives (no attacker-minted ids)", async () => {
    const h = makeRouterHarness();
    await h.play([
      "append",
      ROUTER_BORN,
      {
        type: "events.iterate.com/email/received",
        payload: receivedPayload({ threadTag: "999" }),
      },
    ]);

    // The unknown tag did NOT become the thread id; the offset did.
    expect(h.state().threads).toEqual({ "2": "/agents/email/t2" });
    expect(h.network.streams.has("/agents/email/t999")).toBe(false);
  });

  it("replays the forward when the routed append fails instead of dropping the mail", async () => {
    const h = makeRouterHarness();
    await h.play(["append", ROUTER_BORN]);
    // A cold routed stream rejects the creation batch (the batch is atomic:
    // the injected failure on its final event commits nothing).
    const routed = h.network.get("/agents/email/t2");
    routed.failAppendsOfType = "events.iterate.com/email/received";

    await expect(
      h.append({ type: "events.iterate.com/email/received", payload: receivedPayload({}) }),
    ).rejects.toThrow(/injected append failure/);
    // The cursor is held BEFORE the received event; nothing reached the
    // routed stream, but the route fact already committed on the router's own
    // stream (the blocked work appends it first).
    await expect(h.runner().snapshot()).resolves.toMatchObject({ offset: 1 });
    expect(routed.events).toHaveLength(0);

    // The retry replays from the un-advanced cursor; the forward lands and
    // the route fact dedupes on its idempotency key.
    routed.failAppendsOfType = undefined;
    await h.settle();
    expect(routed.events.map((event) => event.type)).toEqual(ROUTED_CREATION_EVENT_TYPES);
    expect(h.events("events.iterate.com/email/thread-route-configured")).toHaveLength(1);
  });

  it("a full replay (fresh cursor over the same stream) re-forwards nothing: every append dedupes on its key", async () => {
    // The harshest at-least-once redelivery: a fresh progress store over the
    // SAME stream replays every event, so every blocked forward (creation
    // batch, route fact, forwarded mail) re-runs. Each body is deterministic
    // from the event and reduced state, so the re-appends dedupe instead of
    // wedging on a same-key-different-body rejection.
    const h = makeRouterHarness();
    await h.play(
      [
        "append",
        ROUTER_BORN,
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({ messageId: "msg-1@mail.example" }),
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/email/received",
          payload: receivedPayload({ threadTag: "2", messageId: "msg-2@mail.example" }),
        },
      ],
    );
    const routerOffsets = h.events().map((row) => row.offset);
    const routedRows = h.network.eventsAt("/agents/email/t2").map((row) => [row.offset, row.type]);

    const replay = makeRouterHarness({
      clock: h.clock,
      network: h.network,
      progress: makeMemoryProgressStore(EmailProcessorContract),
    });
    await replay.settle(); // replays the whole stream; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(routerOffsets);
    expect(h.network.eventsAt("/agents/email/t2").map((row) => [row.offset, row.type])).toEqual(
      routedRows,
    );
    expect(replay.state().threads).toEqual({ "2": "/agents/email/t2" });
    expect(replay.state().threadByMessageId).toEqual({
      "msg-1@mail.example": "2",
      "msg-2@mail.example": "2",
    });
  });
});

describe("EMAIL_AGENT_SYSTEM_PROMPT", () => {
  it("teaches the reply door and forbids the wrong ones", () => {
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("itx.email.reply");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("never use itx.chat.sendMessage");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("attachments");
  });
});
