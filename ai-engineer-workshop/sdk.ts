import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  createEventsClient as createBaseEventsClient,
  eventsContract,
} from "../apps/events-contract/src/sdk.ts";
import type { EventsORPCClient } from "../apps/events-contract/src/sdk.ts";

export {
  eventsContract,
  type EventsORPCClient,
  PullSubscriptionProcessorRuntime,
  PullSubscriptionPatternProcessorRuntime,
  defineBuiltinProcessor,
  defineProcessor,
  EventInput,
  GenericEventInput,
  type BuiltinProcessor,
  type Processor,
  type ProcessorAppendInput,
  type RelativeStreamPath,
} from "../apps/events-contract/src/sdk.ts";
export type { Event, EventType, JSONObject, StreamPath } from "../apps/events-contract/src/sdk.ts";
export * from "./test-helpers.ts";

const iterateProjectHeader = "x-iterate-project";
const defaultBaseUrl = "https://events.iterate.com";

export function createEventsClient({
  baseUrl = process.env.BASE_URL || defaultBaseUrl,
  projectSlug,
}: {
  baseUrl?: string;
  projectSlug?: string;
} = {}): EventsORPCClient {
  if (projectSlug == null) {
    return createBaseEventsClient(baseUrl);
  }

  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
      fetch: (request: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
        headers.set("connection", "close");
        headers.set(iterateProjectHeader, projectSlug);
        return fetch(request, { ...init, headers });
      },
    }),
  ) as EventsORPCClient;
}

export function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}

export function getDefaultWorkshopPathPrefix() {
  return normalizePathPrefix(process.env.PATH_PREFIX || `/${execSync("id -un").toString().trim()}`);
}

export function isMainModule(importMetaUrl: string) {
  if (!process.argv[1]) {
    return false;
  }

  return importMetaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

export function runWorkshopMain(
  importMetaUrl: string,
  run: (pathPrefix?: string) => Promise<void>,
) {
  if (!isMainModule(importMetaUrl)) {
    return;
  }

  process.env.PATH_PREFIX ||= getDefaultWorkshopPathPrefix();

  void run(process.env.PATH_PREFIX).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
