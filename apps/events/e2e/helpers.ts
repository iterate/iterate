import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  Offset,
  SUBSCRIPTION_REMOVED_TYPE,
  SUBSCRIPTION_SET_TYPE,
  type Event,
  type EventInput,
  eventsContract,
} from "@iterate-com/events-contract";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { z } from "zod";

const createdAt = z.iso.datetime({ offset: true });
const streamStateSchema = z.object({
  path: z.string().nullable(),
  lastOffset: Offset.nullable(),
  eventCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.json()),
  subscriptions: z.record(
    z.string(),
    z.object({
      type: z.literal("webhook"),
      url: z.url(),
      headers: z.record(z.string(), z.string()),
      revision: z.number().int().nonnegative(),
      cursor: z.object({
        lastAcknowledgedOffset: Offset.nullable(),
        nextDeliveryAt: createdAt.nullable(),
        retries: z.number().int().nonnegative(),
        lastError: z
          .object({
            message: z.string(),
            statusCode: z.number().int().nullable(),
            bodyPreview: z.string().nullable(),
            at: createdAt,
          })
          .nullable(),
      }),
    }),
  ),
});

export type Events2Client = ContractRouterClient<typeof eventsContract>;

export type Events2AppFixture = {
  baseURL: string;
  client: Events2Client;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
};

export function requireEventsBaseUrl() {
  const value = process.env.EVENTS_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "EVENTS_BASE_URL is required for events network e2e tests. Start apps/events locally in tmux and run with EVENTS_BASE_URL=http://127.0.0.1:5174, or point at a deployed worker when the task needs that coverage.",
    );
  }

  return value.replace(/\/+$/, "");
}

export function createEvents2AppFixture(args: { baseURL: string }): Events2AppFixture {
  const baseURL = args.baseURL.replace(/\/+$/, "");
  const client = createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseURL).toString(),
    }),
  ) as Events2Client;

  return {
    baseURL,
    client,
    fetch: (pathname, init) => fetch(new URL(pathname, baseURL), init),
  };
}

/**
 * These helpers intentionally keep the e2e tests black-box. They only talk to
 * the worker over HTTP and parse `getState()` locally when a test needs to make
 * assertions about the reduced projection.
 */
export function createEventsE2eFixture(args: { baseURL: string }) {
  const app = createEvents2AppFixture(args);
  const userEventType = "https://events.iterate.com/events/example/value-recorded";

  return {
    ...app,
    newStreamPath(prefix = "/subscriptions") {
      return `${prefix}/${randomUUID().slice(0, 8)}`;
    },
    expectedOffset(value: number) {
      return String(value).padStart(16, "0");
    },
    subscriptionSet(args: {
      path: string;
      slug: string;
      startFrom: "head" | "tail" | { afterOffset: string | null };
      url: string;
      headers?: Record<string, string>;
    }): EventInput {
      const subscription = {
        type: "webhook",
        url: args.url,
        startFrom: args.startFrom,
      } as const;

      return {
        path: args.path,
        type: SUBSCRIPTION_SET_TYPE,
        payload: {
          slug: args.slug,
          subscription:
            args.headers == null ? subscription : { ...subscription, headers: args.headers },
        },
      };
    },
    subscriptionRemoved(args: { path: string; slug: string }): EventInput {
      return {
        path: args.path,
        type: SUBSCRIPTION_REMOVED_TYPE,
        payload: {
          slug: args.slug,
        },
      };
    },
    userEvent(args: { path: string; payload: EventInput["payload"] }): EventInput {
      return {
        path: args.path,
        type: userEventType,
        payload: args.payload,
      };
    },
    async getParsedState(streamPath: string) {
      return streamStateSchema.parse(await app.client.getState({ streamPath }));
    },
    async waitForState(args: {
      predicate: (state: z.infer<typeof streamStateSchema>) => boolean;
      streamPath: string;
      timeoutMs?: number;
    }) {
      let lastState = await streamStateSchema.parseAsync(
        await app.client.getState({ streamPath: args.streamPath }),
      );

      try {
        await vi.waitFor(
          async () => {
            lastState = await streamStateSchema.parseAsync(
              await app.client.getState({ streamPath: args.streamPath }),
            );
            if (!args.predicate(lastState)) {
              throw new Error("state not ready yet");
            }
          },
          {
            interval: 50,
            timeout: args.timeoutMs ?? 5_000,
          },
        );
      } catch (error) {
        throw new Error(
          `Timed out waiting for stream state on ${args.streamPath}: ${JSON.stringify(lastState, null, 2)}`,
          { cause: error },
        );
      }

      return lastState;
    },
  };
}

/**
 * Webhook sinks inspect recorded HTTP traffic instead of reaching into worker
 * internals. That keeps the subscription tests runnable against local or
 * deployed workers with the same assertions.
 */
export async function useWebhookSink(args: { pathname: string }) {
  const server = await useMockHttpServer({ onUnhandledRequest: "error" });
  const endpointUrl = new URL(args.pathname, server.url).toString();
  const deliveries = () =>
    server
      .getHar()
      .log.entries.filter((entry) => entry.request.url === endpointUrl)
      .map((entry) => {
        const bodyText = entry.request.postData?.text ?? null;
        return {
          bodyText,
          payload: bodyText == null ? null : (JSON.parse(bodyText) as { event: Event }),
          startedAtMs: Date.parse(entry.startedDateTime),
        };
      });

  return {
    ...server,
    endpointUrl,
    replyJson(status: number, body: EventInput["payload"]) {
      server.use(http.post(endpointUrl, () => HttpResponse.json(body, { status })));
    },
    replySequence(responses: Array<() => Response | Promise<Response>>) {
      let nextIndex = 0;
      server.use(
        http.post(endpointUrl, async () => {
          const response = responses[Math.min(nextIndex, responses.length - 1)]!;
          nextIndex += 1;
          return response();
        }),
      );
    },
    deliveries,
    eventTypes() {
      return deliveries()
        .map((delivery) => delivery.payload?.event.type)
        .filter((type): type is string => type != null);
    },
    async waitForCount(args: { count: number; timeoutMs?: number }) {
      await vi.waitFor(
        () => {
          if (deliveries().length !== args.count) {
            throw new Error(
              `Expected ${args.count} deliveries, saw ${deliveries().length} to ${endpointUrl}.`,
            );
          }
        },
        {
          interval: 50,
          timeout: args.timeoutMs ?? 5_000,
        },
      );

      return deliveries();
    },
  };
}

export async function collectAsyncIterableUntilIdle<T>(args: {
  iterable: AsyncIterable<T>;
  idleMs: number;
}) {
  const iterator = args.iterable[Symbol.asyncIterator]();
  const values: T[] = [];

  try {
    while (true) {
      const next = await Promise.race([
        iterator.next().then((result) => ({ kind: "next" as const, result })),
        delay(args.idleMs).then(() => ({ kind: "idle" as const })),
      ]);

      if (next.kind === "idle") {
        return values;
      }

      if (next.result.done) {
        return values;
      }

      values.push(next.result.value);
    }
  } finally {
    await iterator.return?.();
  }
}
