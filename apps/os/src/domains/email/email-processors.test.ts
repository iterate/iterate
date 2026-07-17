import { describe, expect, it } from "vitest";
import type { StreamEventInput } from "../streams/schemas.ts";
import { EMAIL_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import { MemoryStreamNetwork, driveProcessor } from "../streams/test-helpers.ts";
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

function newEmailRouter(input: ConstructorParameters<typeof EmailProcessor>[0]): EmailProcessor {
  void input.stream.append({
    type: "events.iterate.com/email/created",
    idempotencyKey: "test:email-router-created",
    payload: { config: {} },
  });
  return new EmailProcessor(input);
}

function newEmailAgent(
  input: ConstructorParameters<typeof EmailAgentProcessor>[0],
): EmailAgentProcessor {
  void input.stream.append({
    type: "events.iterate.com/email-agent/created",
    idempotencyKey: "test:email-agent-created",
    payload: { config: { threadId: "1" } },
  });
  return new EmailAgentProcessor(input);
}

describe("EmailProcessor (thread router)", () => {
  it("throws when a second email-router birth certificate is reduced", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);
    await stream.append({
      type: "events.iterate.com/email/created",
      payload: { config: {} },
    });

    await expect(driver.deliver()).rejects.toThrow("more than one email/created event");
  });

  it("creates a thread route keyed by the received event's offset and forwards", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await driver.deliver();

    // The birth certificate is offset 1, so the first received event owns thread id 2.
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

    // The routed stream is explicitly born and subscribed before its route context and mail.
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
      "events.iterate.com/agents/context-added",
      "events.iterate.com/email/thread-route-configured",
      "events.iterate.com/email/received",
    ]);
    expect(routed[8]).toMatchObject({
      payload: {
        content: EMAIL_AGENT_SYSTEM_PROMPT,
        key: "agent/system-prompt",
        role: "system",
      },
    });
    expect(routed[10]!.payload).toEqual(receivedPayload({}));
    expect(driver.state.threads).toEqual({ "2": "/agents/email/t2" });
    expect(driver.state.threadByMessageId).toEqual({ "msg-1@mail.example": "2" });
  });

  it("routes a +t-tagged reply to the existing thread without a new route", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@mail.example" }),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "2", messageId: "msg-2@mail.example" }),
    });
    await driver.deliver();

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
    expect(driver.state.threadByMessageId["msg-2@mail.example"]).toBe("2");
  });

  it("routes an untagged reply via In-Reply-To/References to the existing thread", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

    expect(
      network
        .eventsAt("/agents/email/t2")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
    expect(network.streams.has("/agents/email/t3")).toBe(false);
  });

  it("routes replies to the agent's own outbound mail via the email/sent index", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

    expect(
      network
        .eventsAt("/agents/email/t2")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
  });

  it("folds sender-allowed patterns into the project allowlist, deduped and case-folded", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

    expect(driver.state.allowedSenders).toEqual(["jonas@example.com", "*@iterate.com"]);
  });

  it("forwards replies to agent-initiated threads to the SENDING agent's stream", async () => {
    // An agent-scoped itx.email.send binds its conversation to the calling
    // agent: it appends this route event (streamPath = the agent's own path,
    // NOT /agents/email/**) and a sent audit fact carrying the threadId.
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

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
    await driver.deliver();

    const forwarded = network
      .eventsAt("/agents/slack/conn/c123/ts-1")
      .filter((event) => event.type === "events.iterate.com/email/received");
    expect(forwarded).toHaveLength(2);
    // No stray /agents/email/t<n> threads were minted for either reply.
    expect([...network.streams.keys()].filter((p) => p.startsWith("/agents/email/"))).toEqual([]);
  });

  it("starts a new thread when an unknown +t tag arrives (no attacker-minted ids)", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "999" }),
    });
    await driver.deliver();

    // The unknown tag did NOT become the thread id; the offset did.
    expect(driver.state.threads).toEqual({ "2": "/agents/email/t2" });
    expect(network.streams.has("/agents/email/t999")).toBe(false);
  });

  it("replays the forward when the routed append fails instead of dropping the mail", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
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
    const processor = newEmailRouter({ stream, path: stream.path, projectId: "prj_1" });
    const driver = driveProcessor(processor, stream);
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });

    await expect(driver.deliver()).rejects.toThrow(/StreamsCapability/);
    await expect(driver.snapshot()).resolves.toMatchObject({ offset: 0 });
    expect(routed.events).toHaveLength(0);

    // The retry replays from the un-advanced cursor; the forward lands and
    // the cursor advances through the route fact the failed attempt had
    // already committed to the router's own stream.
    await driver.deliver();
    expect(routed.events.map((event) => event.type)).toEqual([
      "events.iterate.com/agent/created",
      "events.iterate.com/capability-host/created",
      "events.iterate.com/email-agent/created",
      "events.iterate.com/capability-host/capability-provided",
      "events.iterate.com/agents/context-added",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/agents/context-added",
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
  function setup(deps?: {
    resolveStoredAttachments?: ConstructorParameters<
      typeof EmailAgentProcessor
    >[0]["resolveStoredAttachments"];
  }) {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/email/t1");
    const processor = newEmailAgent({
      stream,
      path: stream.path,
      projectId: null,
      ...deps,
    });
    const driver = driveProcessor(processor, stream);
    return { driver, network, processor, stream };
  }

  it("throws when a second email-agent birth certificate is reduced", async () => {
    const { driver, stream } = setup();
    await stream.append({
      type: "events.iterate.com/email-agent/created",
      payload: { config: { threadId: "1" } },
    });

    await expect(driver.deliver()).rejects.toThrow("more than one email-agent/created event");
  });

  it("attaches door-stored attachments to the agent context item as files", async () => {
    const resolved = {
      contentType: "application/pdf",
      filename: "report.pdf",
      path: "/email/inbound/msg-0-report.pdf",
      size: 1234,
      url: "https://iterate-files--acme.iterate.app/report.pdf?sig=x",
    };
    const seen: unknown[] = [];
    const { driver, stream } = setup({
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
    await driver.deliver();

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

  it("a failed attachment resolution forwards the mail with an explicit loss note", async () => {
    const { driver, stream } = setup({
      resolveStoredAttachments: async () => {
        throw new Error("signing exploded");
      },
    });

    const payload = receivedPayload({});
    payload.message.attachments = [
      { filename: "cat.png", mimeType: "image/png", size: 3, path: "/email/inbound/msg-0-cat.png" },
    ];
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await driver.deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).not.toHaveProperty("files");
    const content = (inputs[0]!.payload as { content: string }).content;
    expect(content).toContain("cat.png");
    // Never a silent drop: the loss and its cause are visible to the model.
    expect(content).toContain("[1 attachment(s) could not be loaded: signing exploded]");
  });

  it("captures thread context and transcribes inbound mail into triggering agent context", async () => {
    const { driver, stream } = setup();

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
    await driver.deliver();

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

    expect(driver.state).toMatchObject({
      threadId: "1",
      streamPath: "/agents/email/t1",
      counterpart: "jonas@example.com",
      subject: "Hello agent",
    });
  });

  it("records automated mail as non-triggering input (mail-loop guard)", async () => {
    const { driver, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ automated: true }),
    });
    await driver.deliver();

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agents/context-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  it("never lets automated mail become the thread counterpart", async () => {
    const { driver, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ automated: true, from: "mailer-daemon@example.com" }),
    });
    await driver.deliver();

    // The human sender stays the counterpart even after a later bounce.
    expect(driver.state.counterpart).toBe("jonas@example.com");
  });

  it("ignores the project's own mail looping back, including for counterpart state", async () => {
    const { driver, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ from: "acme@iterate.app" }),
    });
    await driver.deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(1);
    // Our own looped-back mail never becomes the thread counterpart — the
    // human sender stays the reply target.
    expect(driver.state.counterpart).toBe("jonas@example.com");
  });

  it("falls back to the envelope from when MIME parsing yields no From mailbox", async () => {
    const { driver, stream } = setup();

    const payload = receivedPayload({});
    payload.message.from = { name: "Jonas" };
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await driver.deliver();

    // The envelope sender — the address ingress authenticated — becomes the
    // counterpart, so email.reply still has a target.
    expect(driver.state.counterpart).toBe("jonas@example.com");
  });

  it("filters mail from the project's own tagged addresses as loop-back", async () => {
    const { driver, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ from: "acme+t42@iterate.app" }),
    });
    await driver.deliver();

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agents/context-added"),
    ).toHaveLength(0);
    expect(driver.state.counterpart).toBeUndefined();
  });

  it("skips a Reply-To pointing back at the project itself (never mail ourselves)", async () => {
    const { driver, stream } = setup();

    const payload = receivedPayload({});
    payload.message.replyToAddress = "acme+t1@iterate.app";
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await driver.deliver();

    // The project-owned Reply-To is skipped; the human From wins.
    expect(driver.state.counterpart).toBe("jonas@example.com");
  });

  it("prefers Reply-To over From as the thread counterpart", async () => {
    const { driver, stream } = setup();

    const payload = receivedPayload({});
    payload.message.replyToAddress = "replies@example.com";
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await driver.deliver();

    expect(driver.state.counterpart).toBe("replies@example.com");
  });
});

describe("EMAIL_AGENT_SYSTEM_PROMPT", () => {
  it("teaches the reply door and forbids the wrong ones", () => {
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("itx.email.reply");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("never use itx.chat.sendMessage");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("attachments");
  });
});
