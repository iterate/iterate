import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ContractRouterClient } from "@orpc/contract";
import {
  eventsContract,
  type Event,
  type EventInput,
  type StreamPath,
} from "../apps/events-contract/src/sdk.ts";
import type { Processor } from "../apps/events/src/durable-objects/define-processor.ts";
import { PullSubscriptionProcessorRuntime } from "../apps/events-contract/src/sdk.ts";
import { createEventsClient } from "./sdk.ts";

export const defaultWorkshopBaseUrl = "https://events.iterate.com";
export const defaultWorkshopProjectSlug = "public";

type ProjectScopedEventsClient = ContractRouterClient<typeof eventsContract>;
type StoppableProcessor = Processor<unknown> & { stop?: () => void };

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
}) {
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
} = {}) {
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
      for await (const event of await client.stream({ path: streamPath }, {})) {
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
          new PullSubscriptionProcessorRuntime({
            eventsClient: client,
            processor,
            streamPath,
          }),
      );
      const runPromise = Promise.all(runtimes.map((runtime) => runtime.run()));
      await delay(1_000);

      return {
        runPromise,
        stop() {
          for (const processor of processors) {
            processor.stop?.();
          }

          for (const runtime of runtimes) {
            runtime.stop();
          }
        },
        async stopAndWait(timeoutMs = 2_000) {
          this.stop();
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
