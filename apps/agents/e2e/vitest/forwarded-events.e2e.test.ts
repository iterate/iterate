import { fileURLToPath } from "node:url";
import type { StreamPath } from "@iterate-com/events-contract";
import {
  useCloudflareTunnel,
  useCloudflareTunnelLease,
  useDevServer,
} from "@iterate-com/shared/test-helpers";
import { describe, expect, test } from "vitest";
import { injectVitestRunSlug } from "../test-support/vitest-inject-run-slug.ts";
import {
  createEventsStreamPath,
  createTestExecutionSuffix,
} from "../test-support/vitest-naming.ts";
import {
  eventsIterateStreamViewerUrl,
  waitForStreamEvent,
} from "../test-support/events-stream-helpers.ts";
import { requireSemaphoreE2eEnv } from "../test-support/require-semaphore-e2e-env.ts";
import { createEventsOrpcClient } from "../../src/lib/events-orpc-client.ts";

requireSemaphoreE2eEnv(process.env);

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

describe.sequential("agents forwarded events", () => {
  test("receives a real events.iterate.com webhook and appends pong to the same stream", async ({
    task,
  }) => {
    const vitestRunSlug = injectVitestRunSlug();
    const executionSuffix = createTestExecutionSuffix();
    const streamPath = createEventsStreamPath({
      repoRoot,
      testFilePath: task.file.filepath,
      testFullName: task.fullName,
      executionSuffix,
    }) as StreamPath;
    const eventsBaseUrl = resolveEventsBaseUrl();
    const streamViewerUrl = eventsIterateStreamViewerUrl({
      eventsOrigin: eventsBaseUrl,
      projectSlug: vitestRunSlug,
      streamPath,
    });
    console.info(`[forwarded-events e2e] Events stream (open in browser): ${streamViewerUrl}`);
    await using tunnelLease = await useCloudflareTunnelLease({});

    await using devServer = await useDevServer({
      cwd: appRoot,
      command: "pnpm",
      args: ["exec", "tsx", "./alchemy.run.ts"],
      port: tunnelLease.localPort,
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
    const eventsClient = createEventsOrpcClient({
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

    const pong = await waitForStreamEvent({
      client: eventsClient,
      path: streamPath,
      predicate: (event) => event.type === "pong",
      timeoutMs: 45_000,
    });

    expect(pong.payload).toMatchObject({
      ok: true,
    });
  }, 100_000);
});

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
