import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEventsClient,
  normalizePathPrefix,
  PullProcessorRuntime,
  type Event,
  type EventInput,
  type Processor,
  type StreamPath,
} from "ai-engineer-workshop";
import { fromTrafficWithWebSocket, type HarWithExtensions } from "@iterate-com/mock-http-proxy";
import { setupServer } from "msw/node";
import { expect } from "vitest";

type StoppableProcessor<TState = unknown> = Processor<TState> & { stop?: () => void };

type ProcessorTestRig = {
  append(event: EventInput): Promise<unknown>;
  path: StreamPath;
  waitForEvent(
    predicate: (event: Event) => boolean,
    options?: {
      timeoutMs?: number;
    },
  ): Promise<Event>;
  [Symbol.asyncDispose](): Promise<void>;
};

type UseProcessorTestRigOptions = {
  processors: readonly StoppableProcessor[];
  pathPrefix?: string;
  replayHarPath?: string | URL;
  baseUrl?: string;
  projectSlug?: string;
  testIdentifier?: string;
  openAiApiKey?: string;
};

const replayEnvKeys = ["OPENAI_API_KEY"] as const;

export async function useProcessorTestRig({
  processors,
  pathPrefix = "/packages/agent/tests",
  replayHarPath,
  baseUrl = resolveEventsBaseUrl(),
  projectSlug = resolveProjectSlug(),
  testIdentifier = expect.getState().currentTestName ?? "agent-test",
  openAiApiKey = "sk-agent-test",
}: UseProcessorTestRigOptions): Promise<ProcessorTestRig> {
  const client = createEventsClient({ baseUrl, projectSlug });
  const path = createTestPath({ pathPrefix, testIdentifier });

  const restoreEnv = replayHarPath
    ? await applyHarReplayEnvironment({
        baseUrl,
        replayHarPath,
        openAiApiKey,
      })
    : async () => {};

  const runtimes = processors.map(
    (processor) =>
      new PullProcessorRuntime({
        eventsClient: client,
        includeChildren: false,
        processor,
        path,
      }),
  );

  let runtimeError: unknown;
  const runPromise = Promise.all(
    runtimes.map((runtime) =>
      runtime.run().catch((error) => {
        runtimeError = error;
        throw error;
      }),
    ),
  );
  void runPromise.catch(() => undefined);

  await delay(1_000);

  if (runtimeError != null) {
    await restoreEnv();
    throw runtimeError;
  }

  return {
    append(event) {
      return client.append({ path, event });
    },
    path,
    async waitForEvent(predicate, options = {}) {
      const timeoutMs = options.timeoutMs ?? 15_000;
      const controller = new AbortController();
      let lastOffset: number | undefined;
      let matchedEvent: Event | undefined;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

      throw new Error(`Timed out waiting for event on ${path} after ${String(timeoutMs)}ms`);
    },
    async [Symbol.asyncDispose]() {
      for (const processor of processors) {
        processor.stop?.();
      }

      for (const runtime of runtimes) {
        runtime.stop();
      }

      await Promise.race([runPromise.catch(() => undefined), delay(2_000)]);
      await restoreEnv();
    },
  };
}

function resolveEventsBaseUrl() {
  const defaultBaseUrl = "https://events.iterate.com";
  const trimmed = process.env.EVENTS_BASE_URL?.trim() || process.env.BASE_URL?.trim();
  const candidate = trimmed && trimmed.length > 0 ? trimmed : defaultBaseUrl;
  const withProtocol = /^[a-z]+:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

  try {
    return new URL(withProtocol).toString().replace(/\/+$/, "");
  } catch {
    return defaultBaseUrl;
  }
}

function resolveProjectSlug() {
  return process.env.PROJECT_SLUG?.trim() || "public";
}

function createTestPath({
  pathPrefix,
  testIdentifier,
}: {
  pathPrefix: string;
  testIdentifier: string;
}) {
  const normalizedPrefix = normalizePathPrefix(pathPrefix).replace(/\/+$/, "");
  return `${normalizedPrefix}/${slugify(testIdentifier)}-${randomBytes(6).toString("hex")}` as StreamPath;
}

async function applyHarReplayEnvironment({
  baseUrl,
  replayHarPath,
  openAiApiKey,
}: {
  baseUrl: string;
  replayHarPath: string | URL;
  openAiApiKey: string;
}) {
  const archive = await readHarArchive(replayHarPath);
  const replayHandlers = fromTrafficWithWebSocket(archive) as unknown as Parameters<
    typeof setupServer
  >;
  const server = setupServer(...replayHandlers);
  const eventsHost = new URL(baseUrl).host;
  server.listen({
    onUnhandledRequest(request, print) {
      if (new URL(request.url).host === eventsHost) {
        return;
      }

      print.error();
    },
  });

  const previousEnv = new Map<(typeof replayEnvKeys)[number], string | undefined>();
  for (const key of replayEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }

  process.env.OPENAI_API_KEY = openAiApiKey;

  return async () => {
    for (const key of replayEnvKeys) {
      const previous = previousEnv.get(key);
      if (previous == null) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }

    server.close();
  };
}

async function readHarArchive(pathOrUrl: string | URL) {
  const path = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as HarWithExtensions;
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "test";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
