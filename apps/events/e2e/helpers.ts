import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract";
import { ProjectId, type EventInput, type StreamPath } from "@iterate-com/shared/streams/types";
import { defaultProjectId, getProjectUrl } from "../src/lib/project-id.ts";

export type Events2Client = ContractRouterClient<typeof eventsContract>;
export const defaultE2EProjectId = defaultProjectId;
export const scopedE2EProjectId = "test";
const numberedEventsPreviewHostnamePattern = /^events\.iterate-preview-\d+\.com$/;

export type Events2AppFixture = {
  baseURL: string;
  client: Events2Client;
  append(
    args: { path: StreamPath; event: EventInput } | { streamPath: StreamPath; event: EventInput },
  ): ReturnType<Events2Client["append"]>;
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
};

export function requireEventsBaseUrl() {
  const value = process.env.EVENTS_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "EVENTS_BASE_URL is required for events network e2e tests. Start or deploy the worker outside the test runner, then run the suite with EVENTS_BASE_URL=https://... .",
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
    append: (args) => {
      const streamPath = "streamPath" in args ? args.streamPath : args.path;

      return client.append({
        path: streamPath,
        event: args.event,
      });
    },
    fetch: (pathname, init) => fetch(new URL(pathname, baseURL), init),
  };
}

export function getEventsProjectBaseUrl(args: { baseURL: string; projectId: string }) {
  return getProjectUrl({
    currentUrl: args.baseURL,
    projectId: ProjectId.parse(args.projectId),
  })
    .toString()
    .replace(/\/+$/, "");
}

export function createEvents2ProjectAppFixture(args: { baseURL: string; projectId: string }) {
  return createEvents2AppFixture({
    baseURL: getEventsProjectBaseUrl(args),
  });
}

export function supportsProjectHostRouting(baseURL: string) {
  const hostname = new URL(baseURL).hostname;

  // Numbered preview zones currently have TLS for `*.iterate-preview-N.com`,
  // not the nested `*.events.iterate-preview-N.com` project hosts.
  if (numberedEventsPreviewHostnamePattern.test(hostname)) {
    return false;
  }

  return (
    new URL(getEventsProjectBaseUrl({ baseURL, projectId: scopedE2EProjectId })).hostname !==
    hostname
  );
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
