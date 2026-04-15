import { fileURLToPath } from "node:url";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import {
  Event,
  type Event as EventsEvent,
  eventsContract,
  type StreamPath,
} from "@iterate-com/events-contract";
import {
  getCloudflareTunnelServicePort,
  useCloudflareTunnel,
  useCloudflareTunnelLease,
  useDevServer,
} from "@iterate-com/shared/test-helpers";
import { describe, inject, expect, test } from "vitest";
import {
  createEventsStreamPath,
  createTestExecutionSuffix,
  VITEST_RUN_SLUG_KEY,
} from "../test-support/vitest-naming.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const describeForwardedEvents = hasSemaphoreAccess(process.env)
  ? describe.sequential
  : describe.skip;

describeForwardedEvents("agents forwarded events", () => {
  test("receives a real events.iterate.com webhook and appends pong to the same stream", async ({
    task,
  }) => {
    const vitestRunSlug = inject(VITEST_RUN_SLUG_KEY);
    const executionSuffix = createTestExecutionSuffix();
    const streamPath = createEventsStreamPath({
      repoRoot,
      testFilePath: task.file.filepath,
      testFullName: task.fullName,
      executionSuffix,
    }) as StreamPath;
    const eventsBaseUrl = resolveEventsBaseUrl();
    await using tunnelLease = await useCloudflareTunnelLease({});
    const agentsLocalPort = getCloudflareTunnelServicePort(tunnelLease.service);

    await using devServer = await useDevServer({
      cwd: appRoot,
      command: "pnpm",
      args: ["dev"],
      port: agentsLocalPort,
      env: {
        ...stripInheritedAppConfig(process.env),
        APP_CONFIG_EVENTS_BASE_URL: eventsBaseUrl,
        APP_CONFIG_EVENTS_PROJECT_SLUG: vitestRunSlug,
      },
    });
    await using tunnel = await useCloudflareTunnel({
      token: tunnelLease.tunnelToken,
      publicUrl: tunnelLease.publicUrl,
    });

    const callbackUrl = new URL("/api/events-forwarded/", tunnel.publicUrl).toString();
    const eventsClient = createEventsClient({
      baseUrl: eventsBaseUrl,
      projectSlug: vitestRunSlug,
    });

    await eventsClient.append({
      path: streamPath,
      event: {
        type: "https://events.iterate.com/events/stream/subscription/configured",
        payload: {
          slug: `agents-forwarded-${executionSuffix}`,
          type: "webhook",
          callbackUrl,
        },
      },
    });
    await eventsClient.append({
      path: streamPath,
      event: {
        type: "ping",
        payload: {
          message: `ping ${executionSuffix}`,
          source: devServer.baseUrl,
        },
      },
    });

    const pong = await waitForEvent({
      client: eventsClient,
      path: streamPath,
      predicate: (event) => event.type === "pong",
    });

    expect(pong.payload).toMatchObject({
      ok: true,
    });
  }, 180_000);
});

function createEventsClient(options: {
  baseUrl: string;
  projectSlug: string;
}): ContractRouterClient<typeof eventsContract> {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", options.baseUrl).toString(),
      fetch: (request, init) => {
        const requestInit = init as RequestInit | undefined;
        const headers = new Headers(
          request instanceof Request ? request.headers : requestInit?.headers,
        );
        headers.set("x-iterate-project", options.projectSlug);
        return fetch(request, {
          ...requestInit,
          headers,
        });
      },
    }),
  ) as ContractRouterClient<typeof eventsContract>;
}

async function waitForEvent(args: {
  client: ContractRouterClient<typeof eventsContract>;
  path: StreamPath;
  predicate: (event: EventsEvent) => boolean;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (args.timeoutMs ?? 30_000);
  let lastEvents: EventsEvent[] = [];

  while (Date.now() < deadline) {
    lastEvents = await readHistory(args.client, args.path);
    const matched = lastEvents.find(args.predicate);
    if (matched) {
      return matched;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for matching event on ${args.path}; last history types were ${lastEvents
      .map((event) => event.type)
      .join(", ")}`,
  );
}

async function readHistory(
  client: ContractRouterClient<typeof eventsContract>,
  path: StreamPath,
): Promise<EventsEvent[]> {
  const stream = await client.stream({
    path,
    beforeOffset: "end",
  });
  const iterator = stream[Symbol.asyncIterator]();
  const events: EventsEvent[] = [];

  try {
    while (true) {
      const next = await Promise.race([
        iterator.next().then((result) => ({ kind: "next" as const, result })),
        new Promise<{ kind: "idle" }>((resolve) =>
          setTimeout(() => resolve({ kind: "idle" }), 500),
        ),
      ]);

      if (next.kind === "idle") {
        return events;
      }

      if (next.result.done) {
        return events;
      }

      events.push(Event.parse(next.result.value));
    }
  } finally {
    await iterator.return?.();
  }
}

function resolveEventsBaseUrl() {
  return process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "") || "https://events.iterate.com";
}

function stripInheritedAppConfig(env: NodeJS.ProcessEnv) {
  const next = { ...env };

  for (const key of Object.keys(next)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) {
      delete next[key];
    }
  }

  return next;
}

function hasSemaphoreAccess(env: NodeJS.ProcessEnv) {
  return Boolean(env.SEMAPHORE_API_TOKEN?.trim() && env.SEMAPHORE_BASE_URL?.trim());
}
