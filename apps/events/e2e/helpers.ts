import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract";

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
    fetch: (pathname, init) => fetch(new URL(pathname, baseURL), init),
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
