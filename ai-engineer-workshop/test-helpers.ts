import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  PullProcessorRuntime,
  type Event,
  type EventsORPCClient,
  type Processor,
  type StreamPath,
} from "../apps/events-contract/src/sdk.ts";
import type { EventInput } from "../apps/events-contract/src/types.ts";
import { createEventsClient } from "./sdk.ts";

export const defaultWorkshopBaseUrl = "https://events.iterate.com";
export const defaultWorkshopProjectSlug = "public";

type ProjectScopedEventsClient = EventsORPCClient;
type StoppableProcessor = Processor<unknown> & { stop?: () => void };
type WorkshopProcessorsHandle = {
  runPromise: Promise<void[]>;
  stop(): void;
  stopAndWait(timeoutMs?: number): Promise<void>;
};

export type WorkshopTestHarness = {
  baseUrl: string;
  client: EventsORPCClient;
  projectSlug: string;
  runRootPath: StreamPath;
  append(args: { path: StreamPath; event: EventInput }): ReturnType<EventsORPCClient["append"]>;
  createTestStreamPath(testName: string): StreamPath;
  createTestChildStreamPath(args: { childSlug: string; testName: string }): StreamPath;
  collectEvents(streamPath: StreamPath): Promise<Event[]>;
  startProcessors(args: {
    processors: readonly StoppableProcessor[];
    streamPath: StreamPath;
  }): Promise<WorkshopProcessorsHandle>;
  stream(
    args: Parameters<ProjectScopedEventsClient["stream"]>[0],
    options?: Parameters<ProjectScopedEventsClient["stream"]>[1],
  ): ReturnType<ProjectScopedEventsClient["stream"]>;
  waitForEvent(args: {
    predicate: (event: Event) => boolean;
    streamPath: StreamPath;
    timeoutMs?: number;
  }): Promise<Event>;
};

export function resolveWorkshopBaseUrl(value = process.env.BASE_URL) {
  const trimmed = value?.trim();
  const candidate = trimmed && trimmed.length > 0 ? trimmed : defaultWorkshopBaseUrl;
  const withProtocol = /^[a-z]+:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

  try {
    return new URL(withProtocol).toString().replace(/\/+$/, "");
  } catch {
    return defaultWorkshopBaseUrl;
  }
}

export function resolveWorkshopProjectSlug(value = process.env.PROJECT_SLUG) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultWorkshopProjectSlug;
}

export function createProjectScopedEventsClient({
  baseUrl,
  projectSlug,
}: {
  baseUrl: string;
  projectSlug: string;
}): ProjectScopedEventsClient {
  return createEventsClient({ baseUrl, projectSlug });
}

export function createWorkshopTestHarness({
  baseUrl = resolveWorkshopBaseUrl(),
  projectSlug = resolveWorkshopProjectSlug(),
  runRootPath = createWorkshopTestRunRootPath(),
}: {
  baseUrl?: string;
  projectSlug?: string;
  runRootPath?: StreamPath;
} = {}): WorkshopTestHarness {
  const client = createEventsClient({ baseUrl, projectSlug });

  return {
    baseUrl,
    client,
    projectSlug,
    runRootPath,
    append(args: { path: StreamPath; event: EventInput }) {
      return client.append(args);
    },
    createTestStreamPath(testName: string) {
      return `${runRootPath}/${slugifyPathSegment(testName)}` as StreamPath;
    },
    createTestChildStreamPath({ childSlug, testName }: { childSlug: string; testName: string }) {
      return `${runRootPath}/${slugifyPathSegment(testName)}/${slugifyPathSegment(childSlug)}` as StreamPath;
    },
    async collectEvents(streamPath: StreamPath) {
      const events: Event[] = [];
      for await (const event of await client.stream(
        { path: streamPath, beforeOffset: "end" },
        {},
      )) {
        events.push(event);
      }
      return events;
    },
    async startProcessors({
      processors,
      streamPath,
    }: {
      processors: readonly StoppableProcessor[];
      streamPath: StreamPath;
    }) {
      const runtimes = processors.map(
        (processor) =>
          new PullProcessorRuntime({
            eventsClient: client,
            includeChildren: false,
            processor,
            path: streamPath,
          }),
      );
      const runPromise = Promise.all(runtimes.map((runtime) => runtime.run()));
      await delay(1_000);
      const stop = () => {
        for (const processor of processors) {
          processor.stop?.();
        }

        for (const runtime of runtimes) {
          runtime.stop();
        }
      };

      return {
        runPromise,
        stop,
        async stopAndWait(timeoutMs = 2_000) {
          stop();
          await Promise.race([runPromise.catch(() => undefined), delay(timeoutMs)]);
        },
      };
    },
    stream(
      args: Parameters<ProjectScopedEventsClient["stream"]>[0],
      options?: Parameters<ProjectScopedEventsClient["stream"]>[1],
    ) {
      return client.stream(args, options ?? {});
    },
    async waitForEvent({
      predicate,
      streamPath,
      timeoutMs = 15_000,
    }: {
      predicate: (event: Event) => boolean;
      streamPath: StreamPath;
      timeoutMs?: number;
    }) {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const events = await this.collectEvents(streamPath);
        const match = events.find(predicate);
        if (match) {
          return match;
        }

        await delay(250);
      }

      throw new Error(`Timed out waiting for event on ${streamPath}`);
    },
  };
}

export function createWorkshopTestRunRootPath(prefix = "/ai-engineer-workshop-e2e") {
  return `${prefix}/${randomBytes(6).toString("hex")}` as StreamPath;
}

function slugifyPathSegment(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : randomBytes(4).toString("hex");
}
