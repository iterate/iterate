import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import {
  createEventsClient,
  normalizePathPrefix,
  PullSubscriptionProcessorRuntime,
  type Event,
  type EventInput,
  type EventsORPCClient,
  type Processor,
  type StreamPath,
} from "../sdk.ts";
import { resolveWorkshopBaseUrl, resolveWorkshopProjectSlug } from "../test-helpers.ts";

type StoppableProcessor<TState> = Processor<TState> & { stop?: () => void };

export type ProcessorTestHarness<TState> = {
  baseUrl: string;
  client: EventsORPCClient;
  path: StreamPath;
  processor: StoppableProcessor<TState>;
  projectSlug: string;
  append(event: EventInput): Promise<unknown>;
  collectEvents(): Promise<Event[]>;
  waitForEvent(
    predicate: (event: Event) => boolean,
    options?: {
      timeout?: number;
    },
  ): Promise<Event>;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function useProcessorTestHarness<TState>({
  processor,
  pathPrefix,
  baseUrl = resolveWorkshopBaseUrl(),
  projectSlug = resolveWorkshopProjectSlug(),
  testIdentifier = expect.getState().currentTestName ?? processor.slug,
}: {
  processor: StoppableProcessor<TState>;
  pathPrefix: string;
  baseUrl?: string;
  projectSlug?: string;
  testIdentifier?: string;
}): Promise<ProcessorTestHarness<TState>> {
  const client = createEventsClient({ baseUrl, projectSlug });
  const path = createProcessorTestPath({ pathPrefix, testIdentifier });
  const runtime = new PullSubscriptionProcessorRuntime({
    eventsClient: client,
    processor,
    streamPath: path,
  });

  let runtimeError: unknown;
  const runPromise = runtime.run().catch((error) => {
    runtimeError = error;
    throw error;
  });
  void runPromise.catch(() => undefined);

  await delay(1_000);

  if (runtimeError != null) {
    throw runtimeError;
  }

  async function collectEvents() {
    const events: Event[] = [];

    for await (const event of await client.stream({ path, beforeOffset: "end" }, {})) {
      events.push(event);
    }

    return events;
  }

  return {
    baseUrl,
    client,
    path,
    processor,
    projectSlug,
    append(event) {
      return client.append({ path, event });
    },
    collectEvents,
    async waitForEvent(predicate, options = {}) {
      const timeout = options.timeout ?? 15_000;
      const controller = new AbortController();
      let lastOffset: number | undefined;
      let matchedEvent: Event | undefined;
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeout);

      const consume = async (stream: AsyncIterable<Event>, skipOffset?: number) => {
        for await (const event of stream) {
          if (skipOffset != null && event.offset === skipOffset) {
            continue;
          }

          lastOffset = event.offset;

          if (!predicate(event)) {
            continue;
          }

          matchedEvent = event;
          controller.abort();
          break;
        }
      };

      try {
        await consume(
          await client.stream({ path, beforeOffset: "end" }, { signal: controller.signal }),
        );

        if (matchedEvent == null) {
          await consume(
            await client.stream(
              {
                path,
                afterOffset: lastOffset ?? "start",
              },
              { signal: controller.signal },
            ),
            lastOffset,
          );
        }
      } catch (error) {
        if (!(controller.signal.aborted && isAbortError(error))) {
          throw error;
        }
      } finally {
        clearTimeout(timeoutId);
      }

      if (matchedEvent != null) {
        return matchedEvent;
      }

      throw new Error(`Timed out waiting for event on ${path} after ${timeout}ms`);
    },
    async [Symbol.asyncDispose]() {
      processor.stop?.();
      runtime.stop();
      await Promise.race([runPromise.catch(() => undefined), delay(2_000)]);
    },
  };
}

function createProcessorTestPath({
  pathPrefix,
  testIdentifier,
}: {
  pathPrefix: string;
  testIdentifier: string;
}) {
  const normalizedPrefix = normalizePathPrefix(pathPrefix).replace(/\/+$/, "");
  return `${normalizedPrefix}/${slugifyPathSegment(testIdentifier)}` as StreamPath;
}

function slugifyPathSegment(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "test";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
