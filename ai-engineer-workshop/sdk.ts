import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "../apps/events-contract/src/orpc-contract.ts";

export {
  eventsContract,
  type EventsORPCClient,
  PullSubscriptionProcessorRuntime,
  PullSubscriptionPatternProcessorRuntime,
} from "../apps/events-contract/src/sdk.ts";
export {
  EventInput as EventInputSchema,
  GenericEventInput as GenericEventInputSchema,
} from "../apps/events-contract/src/types.ts";
export type {
  Event,
  EventInput,
  EventType,
  GenericEventInput,
  JSONObject,
  StreamPath,
} from "../apps/events-contract/src/types.ts";
export {
  defineProcessor,
  type Processor,
  type ProcessorAppendInput,
} from "../apps/events/src/durable-objects/define-processor.ts";
export * from "./test-helpers.ts";

const iterateProjectHeader = "x-iterate-project";
const defaultBaseUrl = "https://events.iterate.com";

export function createEventsClient({
  baseUrl = process.env.BASE_URL || defaultBaseUrl,
  projectSlug,
}: {
  baseUrl?: string;
  projectSlug?: string;
} = {}): ContractRouterClient<typeof eventsContract> {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
      ...(projectSlug != null && {
        fetch: (request: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
          headers.set("connection", "close");
          headers.set(iterateProjectHeader, projectSlug);
          return fetch(request, { ...init, headers });
        },
      }),
    }),
  ) as ContractRouterClient<typeof eventsContract>;
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
