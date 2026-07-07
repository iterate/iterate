import { describe, expect, it } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "../../types.ts";
import { EMAIL_AGENT_SYSTEM_PROMPT } from "../projects/project-processor-implementation.ts";
import { EmailProcessor } from "./email-processor-implementation.ts";
import { EmailAgentProcessor } from "./email-agent-processor-implementation.ts";
import type { InboundEmailPayload } from "./email-processor-contract.ts";

/**
 * In-memory network of streams keyed by path, so router tests can observe the
 * cross-stream forwards (`stream.at(path).append(...)`) next to same-stream
 * appends. Mirrors slack-processors.test.ts.
 */
class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(this, path);
      this.streams.set(path, stream);
    }
    return stream;
  }

  eventsAt(path: string): StreamEvent[] {
    return this.streams.get(path)?.events ?? [];
  }
}

class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  constructor(
    readonly network: MemoryStreamNetwork,
    readonly path: string,
  ) {}

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
      };
      this.events.push(event);
      return event;
    });
  }

  at(path: string): Stream {
    return this.network.get(path);
  }

  async getEvent(): Promise<StreamEvent | undefined> {
    return undefined;
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(): Promise<StreamEvent> {
    throw new Error("MemoryStream does not implement waitForEvent().");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async runtimeState() {
    return { coreProcessorState: null, runtime: { connections: {} } };
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }
}

type ProcessorLike = {
  ingest(input: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

async function deliverNewEvents(input: {
  cursors: Map<object, number>;
  processor: ProcessorLike;
  stream: MemoryStream;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  await input.processor.ingest({ events, streamMaxOffset: input.stream.events.length });
}

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
  it("creates a thread route keyed by the received event's offset and forwards", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });
    await deliverNewEvents({ cursors, processor, stream });

    // The route fact lands on the router's own stream, keyed by offset 1…
    const routeEvents = stream.events.filter(
      (event) => event.type === "events.iterate.com/email/thread-route-configured",
    );
    expect(routeEvents).toHaveLength(1);
    expect(routeEvents[0]!.payload).toMatchObject({
      threadId: "1",
      streamPath: "/agents/email/t1",
      counterpart: "jonas@example.com",
      subject: "Hello agent",
    });

    // …and the routed stream receives [route, received] verbatim.
    const routed = network.eventsAt("/agents/email/t1");
    expect(routed.map((event) => event.type)).toEqual([
      "events.iterate.com/email/thread-route-configured",
      "events.iterate.com/email/received",
    ]);
    expect(routed[1]!.payload).toEqual(receivedPayload({}));
    expect(processor.state.threads).toEqual({ "1": "/agents/email/t1" });
    expect(processor.state.threadByMessageId).toEqual({ "msg-1@mail.example": "1" });
  });

  it("routes a +t-tagged reply to the existing thread without a new route", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ messageId: "msg-1@mail.example" }),
    });
    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "1", messageId: "msg-2@mail.example" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const routed = network
      .eventsAt("/agents/email/t1")
      .filter((event) => event.type === "events.iterate.com/email/received");
    expect(routed).toHaveLength(2);
    expect(
      stream.events.filter(
        (event) => event.type === "events.iterate.com/email/thread-route-configured",
      ),
    ).toHaveLength(1);
    // The reply's message id joined the thread index too.
    expect(processor.state.threadByMessageId["msg-2@mail.example"]).toBe("1");
  });

  it("routes an untagged reply via In-Reply-To/References to the existing thread", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

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
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      network
        .eventsAt("/agents/email/t1")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
    expect(network.streams.has("/agents/email/t2")).toBe(false);
  });

  it("routes replies to the agent's own outbound mail via the email/sent index", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

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
        threadId: "1",
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
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      network
        .eventsAt("/agents/email/t1")
        .filter((event) => event.type === "events.iterate.com/email/received"),
    ).toHaveLength(2);
  });

  it("starts a new thread when an unknown +t tag arrives (no attacker-minted ids)", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const processor = new EmailProcessor({ stream });
    const cursors = new Map<object, number>();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ threadTag: "999" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    // The unknown tag did NOT become the thread id; the offset did.
    expect(processor.state.threads).toEqual({ "1": "/agents/email/t1" });
    expect(network.streams.has("/agents/email/t999")).toBe(false);
  });

  it("replays the forward when the routed append fails instead of dropping the mail", async () => {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/integrations/email");
    const routed = network.get("/agents/email/t1");
    const originalRoutedAppend = routed.append.bind(routed);
    let failNextForward = true;
    routed.append = async (...inputs: StreamEventInput[]) => {
      if (failNextForward) {
        failNextForward = false;
        throw new Error("cold StreamsCapability RPC failed");
      }
      return originalRoutedAppend(...inputs);
    };
    const processor = new EmailProcessor({ stream });
    const [received] = await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({}),
    });

    await expect(processor.ingest({ events: [received!], streamMaxOffset: 1 })).rejects.toThrow(
      /StreamsCapability/,
    );
    expect(processor.checkpointOffset).toBe(0);
    expect(routed.events).toHaveLength(0);

    await processor.ingest({ events: [received!], streamMaxOffset: 1 });
    expect(processor.checkpointOffset).toBe(1);
    expect(routed.events.map((event) => event.type)).toEqual([
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
  function setup() {
    const network = new MemoryStreamNetwork();
    const stream = network.get("/agents/email/t1");
    const processor = new EmailAgentProcessor({ stream });
    const cursors = new Map<object, number>();
    return { cursors, network, processor, stream };
  }

  it("captures thread context and transcribes inbound mail into triggering agent input", async () => {
    const { cursors, processor, stream } = setup();

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
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    const payload = inputs[0]!.payload as { content: string; llmRequestPolicy?: unknown };
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

  it("records automated mail as non-triggering input (mail-loop guard)", async () => {
    const { cursors, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ automated: true }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    const inputs = stream.events.filter(
      (event) => event.type === "events.iterate.com/agent/input-added",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.payload).toMatchObject({
      llmRequestPolicy: { behaviour: "dont-trigger-request" },
    });
  });

  it("ignores the project's own mail looping back", async () => {
    const { cursors, processor, stream } = setup();

    await stream.append({
      type: "events.iterate.com/email/received",
      payload: receivedPayload({ from: "acme@iterate.app" }),
    });
    await deliverNewEvents({ cursors, processor, stream });

    expect(
      stream.events.filter((event) => event.type === "events.iterate.com/agent/input-added"),
    ).toHaveLength(0);
  });

  it("prefers Reply-To over From as the thread counterpart", async () => {
    const { cursors, processor, stream } = setup();

    const payload = receivedPayload({});
    payload.message.replyToAddress = "replies@example.com";
    await stream.append({ type: "events.iterate.com/email/received", payload });
    await deliverNewEvents({ cursors, processor, stream });

    expect(processor.state.counterpart).toBe("replies@example.com");
  });
});

describe("EMAIL_AGENT_SYSTEM_PROMPT", () => {
  it("teaches the reply door and forbids the wrong ones", () => {
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("itx.email.reply");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("never use itx.chat.sendMessage");
    expect(EMAIL_AGENT_SYSTEM_PROMPT).toContain("attachments");
  });
});
