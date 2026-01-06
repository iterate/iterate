import { Context, Effect, Fiber, Layer, Ref, Scope, Stream } from "effect";
import { OpenCodeService } from "../opencode/service.ts";
import type { AgentEvent } from "../schemas/events.ts";
import { EventStore } from "./event-store.ts";

const TRIGGER_EVENT_TYPES = ["user_message"];

function extractTextFromEvent(event: AgentEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload?.text === "string") {
    return payload.text;
  }
  if (typeof payload?.message === "string") {
    return payload.message;
  }
  return null;
}

export class SubscriptionManager extends Context.Tag("SubscriptionManager")<
  SubscriptionManager,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly getActiveAgents: () => Effect.Effect<string[], never>;
  }
>() {}

export const SubscriptionManagerLive = Layer.scoped(
  SubscriptionManager,
  Effect.gen(function* () {
    const eventStore = yield* EventStore;
    const opencode = yield* OpenCodeService;
    const activeSubscriptions = yield* Ref.make<Map<string, Fiber.RuntimeFiber<void, unknown>>>(
      new Map(),
    );

    const startAgentSubscriber = (agentName: string) =>
      Effect.gen(function* () {
        const subscriptions = yield* Ref.get(activeSubscriptions);
        if (subscriptions.has(agentName)) {
          return;
        }

        const startOffset = 0;

        yield* Effect.logInfo(
          `Starting subscriber for agent "${agentName}" from offset ${startOffset}`,
        );

        const eventStream = eventStore.subscribeEvents(agentName, startOffset);

        const fiber = yield* eventStream.pipe(
          Stream.filter((event) => TRIGGER_EVENT_TYPES.includes(event.type)),
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              const text = extractTextFromEvent(event);
              if (!text) {
                return;
              }

              yield* Effect.logInfo(
                `[${agentName}] Received ${event.type}, triggering OpenCode: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
              );
              yield* Effect.annotateCurrentSpan("eventType", event.type);
              yield* Effect.annotateCurrentSpan("textLength", text.length);

              const promptWithInstructions = `
                You are a helpful assistant responding to a user message via Slack.

                IMPORTANT: After processing the user's request, you MUST use the harness_sendMessageToUser tool to send your response back to the user. Do not just think about the answer - you must actually call the tool with your response.

                **User's message:** ${text}

                **Remember:** Call harness_sendMessageToUser with your response.
              `;

              yield* opencode.sendPromptAsync(agentName, promptWithInstructions).pipe(
                Effect.tap(() => Effect.logInfo(`[${agentName}] Prompt sent to OpenCode`)),
                Effect.catchAll((error) =>
                  Effect.logError(`[${agentName}] Failed to send prompt: ${error.message}`),
                ),
              );
            }).pipe(Effect.withSpan("subscriber.processEvent", { attributes: { agentName } })),
          ),
          Stream.runDrain,
          Effect.catchAll((error) => Effect.logError(`[${agentName}] Subscriber error: ${error}`)),
          Effect.fork,
        );

        yield* Ref.update(activeSubscriptions, (m) => {
          const newMap = new Map(m);
          newMap.set(agentName, fiber);
          return newMap;
        });
      }).pipe(Effect.withSpan("subscriber.start", { attributes: { agentName } }));

    const syncSubscriptions = Effect.gen(function* () {
      const agents = yield* eventStore.listAgents().pipe(Effect.orElseSucceed(() => []));
      const subscriptions = yield* Ref.get(activeSubscriptions);

      const newAgents = agents.filter((a) => !subscriptions.has(a));
      if (newAgents.length > 0) {
        yield* Effect.logInfo(`Sync found ${newAgents.length} new agents: ${newAgents.join(", ")}`);
        yield* Effect.annotateCurrentSpan("newAgentsCount", newAgents.length);
      }

      for (const agentName of newAgents) {
        yield* startAgentSubscriber(agentName);
      }
    }).pipe(Effect.withSpan("subscriptionManager.sync"));

    const start = () =>
      Effect.gen(function* () {
        yield* opencode.start().pipe(
          Effect.tap(() => Effect.logInfo("OpenCode server started")),
          Effect.catchAll((error) =>
            Effect.logError(`Failed to start OpenCode server: ${error.message}`),
          ),
        );

        yield* syncSubscriptions;

        yield* syncSubscriptions.pipe(
          Effect.delay("500 millis"),
          Effect.forever,
          Effect.forkScoped,
        );

        yield* Effect.logInfo("Subscription manager started");
      }).pipe(Effect.withSpan("subscriptionManager.start"));

    const getActiveAgents = () =>
      Ref.get(activeSubscriptions).pipe(Effect.map((m) => Array.from(m.keys())));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Shutting down subscription manager...");
        const subscriptions = yield* Ref.get(activeSubscriptions);
        for (const [agentName, fiber] of subscriptions) {
          yield* Fiber.interrupt(fiber);
          yield* Effect.logInfo(`Stopped subscriber for agent: ${agentName}`);
        }
      }),
    );

    return {
      start,
      getActiveAgents,
    };
  }),
);
