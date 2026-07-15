import { describe, expect, test } from "vitest";
import type { StreamEventInput } from "../streams/schemas.ts";
import { makeProcessorHarness } from "../streams/test-helpers.ts";
import { EmailProcessor } from "./email-processor-implementation.ts";
import { EmailAgentProcessor } from "./email-agent-processor-implementation.ts";
import type { InboundEmailPayload } from "./email-processor-contract.ts";

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

describe("EmailProcessor (thread router)", () => {
  test("throws when a second email-router birth certificate is reduced", async () => {
    const { deliver, stream } = routerSetup();
    await stream.append({
      type: "events.iterate.com/email/created",
      payload: { config: {} },
    });

    await expect(deliver()).rejects.toThrow("more than one email/created event");
  });

  test("creates a thread route keyed by the received event's offset and forwards", async () => {
    const { network, stream, processor, deliver } = routerSetup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await deliver();

    // The birth certificate is offset 1, so the first received event owns
    // thread id 2.
    const routeEvents = stream.events.filter(
      (event) => event.type === "events.iterate.com/email/thread-route-configured",
    );
    expect(routeEvents).toHaveLength(1);
    expect(routeEvents[0]!.payload).toMatchObject({
      threadId: "2",
      streamPath: "/agents/email/t2",
      counterpart: "jonas@example.com",
      subject: "Hello agent",
    });

    // The routed stream is explicitly born and subscribed before its route
    // context and first received event arrive.
    const routed = network.eventsAt("/agents/email/t2");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/email-agent/created",
      "events.iterate.com/capability-host/capability-provided",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/email/thread-route-configured",
      "events.iterate.com/email/received",
    ]);
    expect(routed[9]!.payload).toEqual(receivedPayload({}));
    expect(processor.state.threads).toEqual({ "2": "/agents/email/t2" });
    expect(processor.state.threadByMessageId).toEqual({ "msg-1@mail.example": "2" });
  });

  test("routes a +t-tagged reply to the existing thread without a new route", async () => {
    const { network, stream, processor, deliver } = routerSetup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@mail.example" }),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "2", messageId: "msg-2@mail.example" }),
    });
    await deliver();

    const routed = network
      .eventsAt("/agents/email/t2")
      .filter((event) => event.type === "events.iterate.com/email/received");
    expect(routed).toHaveLength(2);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/email/thread-route-configured",
      ),
    ).toHaveLength(1);
    // The reply's message id joined the thread index too.
    expect(processor.state.threadByMessageId["msg-2@mail.example"]).toBe("2");
  });

  test("routes an untagged reply via In-Reply-To/References to the existing thread", async () => {
    const { network, stream, deliver } = routerSetup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@mail.example" }),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({
        messageId: "msg-2@mail.example",
        inReplyTo: "msg-1@mail.example",
        references: ["msg-1@mail.example"],
      }),
    });
    await deliver();

    expect(
      network
        .eventsAt("/agents/email/t2")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
    expect(network.streams.has("/agents/email/t3")).toBe(false);
  });

  test("routes replies to the agent's own outbound mail via the email/sent index", async () => {
    const { network, stream, deliver } = routerSetup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@mail.example" }),
    });
    // The agent replied inside thread 1; the audit fact carries threadId.
    await stream.append({
      type: "events.iterate.com/email/sent",
      payload: {
        from: "acme@iterate.app",
        messageId: "out-1@iterate.app",
        projectId: "prj_1",
        subject: "Re: Hello agent",
        to: "jonas@example.com",
        threadId: "2",
      },
    });
    // The human replies to the agent's mail — In-Reply-To names OUR outbound
    // message id, not theirs, and no +t tag survived.
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({
        messageId: "msg-3@mail.example",
        inReplyTo: "out-1@iterate.app",
      }),
    });
    await deliver();

    expect(
      network
        .eventsAt("/agents/email/t2")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
  });

  test("folds sender-allowed patterns into the project allowlist, deduped and case-folded", async () => {
    const { stream, processor, deliver } = routerSetup();

    await stream.append(
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
    );
    await deliver();

    expect(processor.state.allowedSenders).toEqual(["jonas@example.com", "*@iterate.com"]);
  });

  test("forwards replies to agent-initiated threads to the SENDING agent's stream", async () => {
    // An agent-scoped itx.email.send binds its conversation to the calling
    // agent: it appends this route event (streamPath = the agent's own path,
    // NOT /agents/email/**) and a sent audit fact carrying the threadId.
    const { network, stream, deliver } = routerSetup();

    await stream.append(
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
    );
    // Reply via the +t token…
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "a1b2c3d4e5f6", messageId: "reply-1@mail.example" }),
    });
    // …and a header-only reply to the bare address (In-Reply-To = OUR id).
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({
        messageId: "reply-2@mail.example",
        inReplyTo: "out-slack-1@iterate.app",
      }),
    });
    await deliver();

    const forwarded = network
      .eventsAt("/agents/slack/conn/c123/ts-1")
      .filter((event) => event.type === "events.iterate.com/email/received");
    expect(forwarded).toHaveLength(2);
    // No stray /agents/email/t<n> threads were minted for either reply.
    expect([...network.streams.keys()].filter((p) => p.startsWith("/agents/email/"))).toEqual([]);
  });

  test("starts a new thread when an unknown +t tag arrives (no attacker-minted ids)", async () => {
    const { network, stream, processor, deliver } = routerSetup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "999" }),
    });
    await deliver();

    // The unknown tag did NOT become the thread id; the offset did.
    expect(processor.state.threads).toEqual({ "2": "/agents/email/t2" });
    expect(network.streams.has("/agents/email/t999")).toBe(false);
  });

  test("replays the forward when the routed append fails instead of dropping the mail", async () => {
    const { network, stream, processor, deliver } = routerSetup();
    await deliver();
    const routed = network.get("/agents/email/t2");
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    const [received] = await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });

    await expect(processor.ingest({ events: [received!], streamMaxOffset: 2 })).rejects.toThrow(
      /StreamsCapability/,
    );
    expect(processor.checkpointOffset).toBe(1);
    expect(routed.events).toHaveLength(0);

    await processor.ingest({ events: [received!], streamMaxOffset: 2 });
    expect(processor.checkpointOffset).toBe(2);
    expect(routed.events.map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/email-agent/created",
      "events.iterate.com/capability-host/capability-provided",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/email/thread-route-configured",
      "events.iterate.com/email/received",
    ]);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/email/thread-route-configured",
      ),
    ).toHaveLength(1);
  });
});

describe("EmailAgentProcessor", () => {
  test("throws when a second email-agent birth certificate is reduced", async () => {
    const { deliver, stream } = setup();
    await stream.append({
      type: "events.iterate.com/email-agent/created",
      payload: { config: { threadId: "1" } },
    });

    await expect(deliver()).rejects.toThrow("more than one email-agent/created event");
  });

  test("attaches door-stored attachments to the agent context item as files", async () => {
    const resolved = {
      contentType: "application/pdf",
      filename: "report.pdf",
      path: "/email/inbound/msg-0-report.pdf",
      size: 1234,
      url: "https://iterate-files--acme.iterate.app/report.pdf?sig=x",
    };
    const seen: unknown[] = [];
    const { deliver, stream } = setup({
      resolveStoredAttachments: async (attachments) => {
        seen.push(attachments);
        return [resolved];
      },
    });

    const payload = receivedPayload({});
    payload.message.attachments = [
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 1234,
        path: "/email/inbound/msg-0-report.pdf",
      },
      // Metadata-only attachment (storage failed at the door): not resolved.
      { filename: "broken.bin", mimeType: null, size: 10 },
    ];
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await deliver();

    expect(seen).toEqual([
      [
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          path: "/email/inbound/msg-0-report.pdf",
          size: 1234,
        },
      ],
    ]);
    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({ files: [resolved] });
  });

  test("degrades to a plain transcription when attachment resolution fails", async () => {
    const { deliver, stream } = setup({
      resolveStoredAttachments: async () => {
        throw new Error("signing exploded");
      },
    });

    const payload = receivedPayload({});
    payload.message.attachments = [
      { filename: "cat.png", mimeType: "image/png", size: 3, path: "/email/inbound/msg-0-cat.png" },
    ];
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).not.toHaveProperty("files");
    expect((inputs[0]!.payload as { content: string }).content).toContain("cat.png");
  });

  test("captures thread context and transcribes inbound mail into triggering agent context", async () => {
    const { deliver, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/thread-route-configured",
      payload: {
        threadId: "1",
        streamPath: "/agents/email/t1",
        counterpart: "jonas@example.com",
        subject: "Hello agent",
      },
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as {
      actor?: unknown;
      content: string;
      llmRequestPolicy?: unknown;
      refs?: unknown;
      role: string;
    };
    expect(payload).toMatchObject({
      role: "developer",
      actor: { type: "email", address: "jonas@example.com", name: "Jonas" },
      refs: [
        {
          type: "event",
          streamPath: "/agents/email/t1",
          offset: 3,
          eventType: "events.iterate.com/email/received",
        },
      ],
    });
    expect(payload.content).toContain("email/received");
    expect(payload.content).toContain("jonas@example.com");
    expect(payload.content).toContain("Can you help me with something?");
    // The contract default (triggering) policy applies to human mail.
    expect(payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });

    expect(processor.state).toMatchObject({
      threadId: "1",
      streamPath: "/agents/email/t1",
      counterpart: "jonas@example.com",
      subject: "Hello agent",
    });
  });

  test("records automated mail as non-triggering input (mail-loop guard)", async () => {
    const { deliver, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ automated: true }),
    });
    await deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  test("never lets automated mail become the thread counterpart", async () => {
    const { deliver, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ automated: true, from: "mailer-daemon@example.com" }),
    });
    await deliver();

    // The human sender stays the counterpart even after a later bounce.
    expect(processor.state.counterpart).toBe("jonas@example.com");
  });

  test("ignores the project's own mail looping back, including for counterpart state", async () => {
    const { deliver, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ from: "acme@iterate.app" }),
    });
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(1);
    // Our own looped-back mail never becomes the thread counterpart — the
    // human sender stays the reply target.
    expect(processor.state.counterpart).toBe("jonas@example.com");
  });

  test("falls back to the envelope from when MIME parsing yields no From mailbox", async () => {
    const { deliver, processor, stream } = setup();

    const payload = receivedPayload({});
    payload.message.from = { name: "Jonas" };
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await deliver();

    // The envelope sender — the address ingress authenticated — becomes the
    // counterpart, so email.reply still has a target.
    expect(processor.state.counterpart).toBe("jonas@example.com");
  });

  test("filters mail from the project's own tagged addresses as loop-back", async () => {
    const { deliver, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ from: "acme+t42@iterate.app" }),
    });
    await deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
    expect(processor.state.counterpart).toBeUndefined();
  });

  test("skips a Reply-To pointing back at the project itself (never mail ourselves)", async () => {
    const { deliver, processor, stream } = setup();

    const payload = receivedPayload({});
    payload.message.replyToAddress = "acme+t1@iterate.app";
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await deliver();

    // The project-owned Reply-To is skipped; the human From wins.
    expect(processor.state.counterpart).toBe("jonas@example.com");
  });

  test("prefers Reply-To over From as the thread counterpart", async () => {
    const { deliver, processor, stream } = setup();

    const payload = receivedPayload({});
    payload.message.replyToAddress = "replies@example.com";
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await deliver();

    expect(processor.state.counterpart).toBe("replies@example.com");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routerSetup() {
  const harness = makeProcessorHarness({
    path: "/integrations/email",
    build: ({ stream }) => new EmailProcessor({ stream, path: stream.path, projectId: "prj_1" }),
  });
  harness.stream.events.push({
    type: "events.iterate.com/email/created",
    idempotencyKey: "email/created:test",
    payload: { config: {} },
    createdAt: new Date(0).toISOString(),
    offset: 1,
    path: harness.stream.path,
  });
  return harness;
}

function setup(deps?: {
  resolveStoredAttachments?: ConstructorParameters<
    typeof EmailAgentProcessor
  >[0]["resolveStoredAttachments"];
}) {
  const harness = makeProcessorHarness({
    path: "/agents/email/t1",
    build: ({ stream }) =>
      new EmailAgentProcessor({ stream, path: stream.path, projectId: null, ...deps }),
  });
  harness.stream.events.push({
    type: "events.iterate.com/email-agent/created",
    idempotencyKey: "email-agent/created:test",
    payload: { config: { threadId: "1" } },
    createdAt: new Date(0).toISOString(),
    offset: 1,
    path: harness.stream.path,
  });
  return harness;
}
