import { describe, expect, it } from "vitest";
import { EMAIL_AGENT_SYSTEM_PROMPT } from "../projects/project-processor-implementation.ts";
import { deliverNewEvents, MemoryStreamNetwork } from "../streams/memory-stream-test-support.ts";
import { EmailProcessor } from "./email-processor-implementation.ts";
import { EmailAgentProcessor } from "./email-agent-processor-implementation.ts";

function receivedPayload(input: {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  recipientKind?: "zero-onboarding" | "project";
  text?: string;
}) {
  return {
    projectId: "prj_1",
    recipient: {
      kind: input.recipientKind ?? ("zero-onboarding" as const),
      address: input.recipientKind === "project" ? "joebloggs@iterate.app" : "bot@iterate.app",
    },
    from: { address: "joebloggs@gmail.com", name: "Joe Bloggs" },
    subject: "slime volleyball",
    text: input.text ?? "Make me a browser slime volleyball game",
    messageId: input.messageId,
    ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
    references: input.references ?? [],
    attachments: [],
    provisioned: false,
  };
}

describe("EmailProcessor (thread router)", () => {
  it("routes a fresh email to a new thread agent stream and records the route", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@gmail.com" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    // The route fact lands on the router's own stream…
    const routeEvents = stream.events.filter(
      (event) => event.type === "events.iterate.com/email/thread-route-configured",
    );
    expect(routeEvents).toHaveLength(1);
    expect(routeEvents[0]!.payload).toMatchObject({
      messageIds: ["msg-1@gmail.com"],
      streamPath: "/agents/email/thread-msg-1-gmail-com",
    });

    // …and the routed stream receives the email verbatim.
    const routed = network.eventsAt("/agents/email/thread-msg-1-gmail-com");
    expect(routed.map((event) => event.type)).toEqual(["events.iterate.com/email/received"]);
    expect(routed[0]!.payload).toEqual(receivedPayload({ messageId: "msg-1@gmail.com" }));
  });

  it("routes a reply (In-Reply-To) to the existing thread stream", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@gmail.com" }),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({
        messageId: "msg-2@gmail.com",
        inReplyTo: "msg-1@gmail.com",
        references: ["msg-1@gmail.com"],
        text: "make it two-player please",
      }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt("/agents/email/thread-msg-1-gmail-com");
    expect(routed).toHaveLength(2);
    expect(routed[1]!.payload).toMatchObject({ messageId: "msg-2@gmail.com" });
    // The reply's own Message-ID joins the routing table (so replies to IT
    // route too), pointing at the same thread stream.
    expect(processor.state.threads["msg-2@gmail.com"]).toBe("/agents/email/thread-msg-1-gmail-com");
  });

  it("threads a human reply to the bot's own outbound mail back to the same agent", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    // Inbound establishes the thread; the agent replies via itx.email.send,
    // whose audit event carries the platform-generated outbound Message-ID.
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@gmail.com" }),
    });
    await stream.append({
      type: "events.iterate.com/email/sent",
      payload: {
        from: "joebloggs@iterate.app",
        messageId: "<reply-1@iterate.app>",
        projectId: "prj_1",
        subject: "Re: slime volleyball",
        to: "joebloggs@gmail.com",
        inReplyTo: "msg-1@gmail.com",
        references: ["msg-1@gmail.com"],
      },
    });
    // Joe replies to the BOT's message: In-Reply-To names the outbound id.
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({
        messageId: "msg-3@gmail.com",
        inReplyTo: "reply-1@iterate.app",
        references: ["msg-1@gmail.com", "reply-1@iterate.app"],
        recipientKind: "project",
        text: "love it, add sound effects",
      }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network.eventsAt("/agents/email/thread-msg-1-gmail-com");
    expect(routed.map((event) => (event.payload as { messageId?: string }).messageId)).toEqual([
      "msg-1@gmail.com",
      "msg-3@gmail.com",
    ]);
  });

  it("drops project-addressed mail that matches no known thread", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "cold-1@gmail.com", recipientKind: "project" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    // Nothing forwarded, nothing routed: full project-inbox semantics belong
    // to tasks/os-agent-email-cloudflare-workers.md.
    expect(network.streams.size).toBe(1);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/email/thread-route-configured",
      ),
    ).toHaveLength(0);
  });

  it("dedupes the forward across a replay via idempotency keys", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });

    const [received] = await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@gmail.com" }),
    });
    await processor.ingest({ events: [received!], streamMaxOffset: 1 });
    // The host replays the same batch (e.g. after a wake hiccup).
    await processor.ingest({ events: [received!], streamMaxOffset: 1 });

    expect(network.eventsAt("/agents/email/thread-msg-1-gmail-com")).toHaveLength(1);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/email/thread-route-configured",
      ),
    ).toHaveLength(1);
  });
});

describe("EmailAgentProcessor", () => {
  it("transcribes a routed email into triggering agent input and records reply context", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/email/thread-msg-1-gmail-com");
    const processor = new EmailAgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@gmail.com" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      idempotencyKey: "email-agent:received-to-agent-input:1",
    });
    const content = (inputs[0]!.payload as { content: string }).content;
    expect(content).toContain("email/received");
    expect(content).toContain("joebloggs@gmail.com");
    expect(content).toContain("Make me a browser slime volleyball game");
    expect(content).toContain("msg-1@gmail.com");

    // What the agent's next itx.email.send needs: who to answer, threading ids.
    expect(processor.state).toMatchObject({
      senderAddress: "joebloggs@gmail.com",
      senderName: "Joe Bloggs",
      subject: "slime volleyball",
      lastInboundMessageId: "msg-1@gmail.com",
      references: ["msg-1@gmail.com"],
    });
  });

  it("extends the references chain across the conversation", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/email/thread-msg-1-gmail-com");
    const processor = new EmailAgentProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@gmail.com" }),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({
        messageId: "msg-3@gmail.com",
        inReplyTo: "reply-1@iterate.app",
        references: ["msg-1@gmail.com", "reply-1@iterate.app"],
      }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(processor.state.references).toEqual([
      "msg-1@gmail.com",
      "reply-1@iterate.app",
      "msg-3@gmail.com",
    ]);
    expect(processor.state.lastInboundMessageId).toBe("msg-3@gmail.com");
  });
});

describe("EMAIL_AGENT_SYSTEM_PROMPT", () => {
  it("tells email agents to reply via itx.email.send with threading headers", () => {
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("itx.email.send");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("inReplyTo");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("references");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("Never use itx.chat.sendMessage");
  });
});
