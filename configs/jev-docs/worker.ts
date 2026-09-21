import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { z } from "zod";
import { prepareDocumentation } from "./documentation.ts";

const IncomingMessage = z.object({
  role: z.enum(["user", "developer"]),
  content: z.string(),
  actor: z.object({ type: z.string() }).optional(),
  mentionResolution: z.unknown().optional(),
  llmRequestPolicy: z.object({ behaviour: z.string() }).optional(),
  mentions: z.unknown().optional(),
});

export default class ProjectWorker extends IterateWorkerEntrypoint {
  get documentation() {
    return {
      prepare: (input: { agentPath: string; messages: { role: string; content: string }[] }) =>
        prepareDocumentation(
          this.itx.scope({ path: input.agentPath, surface: ["docs"] }),
          this.itx.ai,
          input.messages,
        ),
    };
  }

  protected override async processEvent(event: StreamEvent): Promise<void> {
    if (event.source?.copiedFrom) return;
    if (
      event.type !== "events.iterate.com/agent/created" &&
      event.type !== "events.iterate.com/agents/context-added"
    )
      return;
    const agent = this.itx.agents.get(event.path);
    if (event.type === "events.iterate.com/agent/created") {
      // The platform's 60s birth window already holds any early message.
      await agent.append({
        type: "events.iterate.com/agent/configured",
        idempotencyKey: "jev-docs/birth:v1",
        payload: { config: { llmRequestDebounceMs: 1_000 } },
      });
      return;
    }
    const parsed = IncomingMessage.safeParse(event.payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (
      message.role === "developer" &&
      (!message.actor ||
        message.actor.type === "script" ||
        message.mentionResolution ||
        (message.llmRequestPolicy?.behaviour === "dont-trigger-request" && !message.mentions))
    )
      return;

    const sentAt = Date.parse(event.createdAt);
    const deliveryDelayMs = Date.now() - sentAt;
    // Delivery is ordered per stream and at least once. Durable markers make
    // replay safe and keep subsequent messages out, even after worker eviction.
    const [birth, lifecycle] = await Promise.all([
      agent.stream.getEvent({ idempotencyKey: "jev-docs/birth:v1" }),
      agent.stream.getEvents({
        eventTypes: ["events.iterate.com/jev-docs/started", "events.iterate.com/jev-docs/settled"],
        limit: 2,
      }),
    ]);
    // Installing this template must not treat an existing chat's next turn as its first.
    if (!birth) return;
    if (lifecycle.some((item) => item.type === "events.iterate.com/jev-docs/settled")) return;
    if (lifecycle[0] && lifecycle[0].payload?.messageOffset !== event.offset) return;
    if (!lifecycle.length) {
      await agent.stream.append({
        type: "events.iterate.com/jev-docs/started",
        idempotencyKey: "jev-docs/started:v1",
        payload: { messageOffset: event.offset },
      });
    }

    const deadline = sentAt + 1_000;
    let status = "timed-out";
    let content = "";
    let metadata: Record<string, unknown> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Error("First-message documentation deadline elapsed");
    try {
      if (Date.now() < deadline) {
        const result = await Promise.race([
          this.documentation.prepare({ agentPath: event.path, messages: [message] }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timeout), Math.max(0, deadline - Date.now()));
          }),
        ]);
        if (Date.now() < deadline) {
          content = result.content;
          metadata = result.metadata;
          status = content ? "selected" : "no-matches";
        }
      }
    } catch (error) {
      status = error === timeout ? "timed-out" : "failed";
      metadata = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // One atomic append: context lands before restoring the fast debounce.
    // A late Jev promise only returns data; it can never append on its own.
    await agent.stream.append(
      ...(content
        ? [
            {
              type: "events.iterate.com/agents/context-added",
              idempotencyKey: "jev-docs/context:v1",
              payload: {
                role: "developer",
                key: "jev-docs/first-message",
                content,
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
              },
            },
          ]
        : []),
      {
        type: "events.iterate.com/jev-docs/settled",
        idempotencyKey: "jev-docs/settled:v1",
        payload: {
          messageOffset: event.offset,
          status,
          deliveryDelayMs,
          durationMs: Date.now() - sentAt,
          ...metadata,
        },
      },
      {
        type: "events.iterate.com/agent/configured",
        idempotencyKey: "jev-docs/released:v1",
        payload: { config: { llmRequestDebounceMs: 250 } },
      },
    );
  }

  async fetch(): Promise<Response> {
    return new Response(
      "Jev first-message experiment: normal chat gets up to one second to select documentation, then uses the ordinary 250ms debounce for all later turns.",
    );
  }
}
