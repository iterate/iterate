import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract, type Event } from "../../apps/events-contract/src/sdk.ts";
import { collectAsyncIterableUntilIdle } from "../../apps/events/e2e/helpers.ts";
import { iterateProjectHeader } from "../../apps/events/src/lib/project-slug.ts";

type EventsClient = ContractRouterClient<typeof eventsContract>;
type SubscriberType = "webhook" | "websocket";
type ProcessorKind = "ping-pong" | "openai-agent";

export async function runPushedProcessorProof(args: {
  callbackBaseUrl: string;
  eventsBaseUrl: string;
  openAiModel?: string;
  processorKind: ProcessorKind;
  projectSlug?: string;
  responseTimeoutMs?: number;
  streamPathPrefix?: string;
  subscriberType: SubscriberType;
}) {
  const client = createEventsClient({
    baseUrl: args.eventsBaseUrl,
    projectSlug: args.projectSlug ?? "test",
  });
  const responseTimeoutMs = args.responseTimeoutMs ?? 20_000;
  const streamPath = `${args.streamPathPrefix ?? "/pushed-processor-proof"}/${args.processorKind}/${args.subscriberType}/${randomUUID().slice(0, 8)}`;
  const processorKey =
    args.processorKind === "openai-agent"
      ? `${args.processorKind}:${args.openAiModel ?? "gpt-4o-mini"}`
      : args.processorKind;
  const subscriptionEvent = createSubscriptionConfiguredEvent({
    callbackBaseUrl: args.callbackBaseUrl,
    eventsBaseUrl: args.eventsBaseUrl,
    openAiModel: args.openAiModel,
    processorKey,
    processorKind: args.processorKind,
    projectSlug: args.projectSlug ?? "test",
    streamPath,
    subscriberType: args.subscriberType,
  });

  try {
    await client.append({
      path: streamPath,
      event: subscriptionEvent,
    });

    if (args.processorKind === "openai-agent") {
      await client.append({
        path: streamPath,
        event: {
          type: "user-message",
          payload: {
            content: "What is 50 - 8? Reply with only the number.",
          },
        },
      });

      const assistantEvent = await waitForEvent({
        client,
        path: streamPath,
        timeoutMs: responseTimeoutMs,
        type: "assistant-message",
      });
      const content = String(
        (assistantEvent.payload as { content?: string } | undefined)?.content ?? "",
      );

      if (!/\b42\b/.test(content)) {
        throw new Error(`Expected assistant-message to contain 42; got: ${content}`);
      }

      const history = await collectHistory(client, streamPath);
      return {
        eventTypes: history.map((event) => event.type),
        outputPreview: content.slice(0, 160),
        streamPath,
        subscriptionEvent,
      };
    }

    await client.append({
      path: streamPath,
      event: {
        type: "value-recorded",
        payload: {
          note: "please ping this",
        },
      },
    });

    await waitForEvent({
      client,
      path: streamPath,
      timeoutMs: responseTimeoutMs,
      type: "pong",
    });

    const history = await collectHistory(client, streamPath);
    return {
      eventTypes: history.map((event) => event.type),
      outputPreview: "pong",
      streamPath,
      subscriptionEvent,
    };
  } finally {
    await client.destroy({
      params: { path: streamPath },
      query: {},
    });
  }
}

function createEventsClient(args: { baseUrl: string; projectSlug: string }) {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", args.baseUrl).toString(),
      fetch: (request, init) => {
        const requestInit = init as RequestInit | undefined;
        const headers = new Headers(
          request instanceof Request ? request.headers : requestInit?.headers,
        );
        headers.set(iterateProjectHeader, args.projectSlug);
        return fetch(request, { ...requestInit, headers });
      },
    }),
  ) as EventsClient;
}

async function waitForEvent(args: {
  client: EventsClient;
  path: string;
  timeoutMs: number;
  type: string;
}) {
  const deadline = Date.now() + args.timeoutMs;

  while (Date.now() < deadline) {
    const history = await collectHistory(args.client, args.path);
    const match = history.find((event) => event.type === args.type);

    if (match != null) {
      return match;
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${args.type} after ${args.timeoutMs}ms`);
}

async function collectHistory(client: EventsClient, path: string) {
  return (await collectAsyncIterableUntilIdle({
    iterable: (await client.stream({ path, beforeOffset: "end" })) as AsyncIterable<Event>,
    idleMs: 500,
  })) as Event[];
}

function createSubscriptionConfiguredEvent(args: {
  callbackBaseUrl: string;
  eventsBaseUrl: string;
  openAiModel?: string;
  processorKey: string;
  processorKind: ProcessorKind;
  projectSlug: string;
  streamPath: string;
  subscriberType: SubscriberType;
}) {
  return {
    type: "https://events.iterate.com/events/stream/subscription/configured" as const,
    payload: {
      callbackUrl: createCallbackUrl(args),
      slug: `processor:${args.processorKey}:${args.subscriberType}`,
      type: args.subscriberType,
    },
  };
}

function createCallbackUrl(args: {
  callbackBaseUrl: string;
  eventsBaseUrl: string;
  openAiModel?: string;
  processorKind: ProcessorKind;
  projectSlug: string;
  streamPath: string;
  subscriberType: SubscriberType;
}) {
  const callbackUrl = new URL("/after-event-handler", args.callbackBaseUrl);
  callbackUrl.searchParams.set("baseUrl", args.eventsBaseUrl);
  callbackUrl.searchParams.set("projectSlug", args.projectSlug);
  callbackUrl.searchParams.set("streamPath", args.streamPath);
  callbackUrl.searchParams.set("streamPattern", "/**/*");
  callbackUrl.searchParams.set("processorKind", args.processorKind);

  if (args.openAiModel != null) {
    callbackUrl.searchParams.set("openaiModel", args.openAiModel);
  }

  if (args.subscriberType === "websocket") {
    callbackUrl.protocol = callbackUrl.protocol === "https:" ? "wss:" : "ws:";
  }

  return callbackUrl.toString();
}
