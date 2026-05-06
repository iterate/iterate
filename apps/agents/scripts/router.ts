import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { os } from "@orpc/server";
import { z } from "zod";
import { useCloudflareTunnel, useCloudflareTunnelLease } from "@iterate-com/shared/test-helpers";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ProjectId } from "@iterate-com/shared/streams/types";
import { createEventsOrpcClient } from "../src/lib/events-orpc-client.ts";
import { buildStreamAppendUrl, buildStreamViewerUrl } from "../src/lib/events-urls.ts";
import {
  buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl,
  streamPathToAgentInstance,
} from "../src/lib/iterate-agent-addressing.ts";
import { createEphemeralWorker } from "../e2e/test-support/create-ephemeral-worker.ts";

const DEFAULT_EVENTS_BASE_URL = "https://events.iterate.com";
const DEFAULT_PROJECT_ID: ProjectId = "public";
const TUNNEL_READY_TIMEOUT_MS = 120_000;
const scriptsDir = dirname(fileURLToPath(import.meta.url));

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal == null) {
    throw new Error("AbortSignal is required so CLI resources can be released on shutdown.");
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * `pnpm cli tunnel …`
 *
 * Acquires a Cloudflare tunnel lease from Semaphore (stable `*.iterate-dev.com`
 * hostname + assigned local port), opens `cloudflared`, appends a
 * `stream/subscription/configured` event so events.iterate.com delivers the
 * given stream over WebSocket to this dev machine, and keeps the tunnel up
 * until Ctrl+C.
 *
 * Ctrl+C → the trpc-cli `signal` aborts → the handler returns → both
 * `await using` handles dispose, killing `cloudflared` and releasing the
 * Semaphore lease back to the pool.
 *
 * The lease dictates which local port the tunnel forwards to, so start
 * `pnpm dev` on the printed port before the tunnel's healthcheck window
 * elapses (defaults to 2 minutes).
 */
const TunnelInput = z.object({
  streamPath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Events stream path (defaults to a random /dev/<slug>)"),
  projectSlug: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_PROJECT_ID)
    .describe("events.iterate.com project slug"),
  eventsBaseUrl: z
    .string()
    .trim()
    .url()
    .default(DEFAULT_EVENTS_BASE_URL)
    .describe("Events base URL"),
  runnerInstance: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Codemode runner Durable Object instance name (defaults to the stream path instance)",
    ),
  subscriptionSlug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Subscription slug on the stream (defaults to a random dev-<slug>)"),
});

const DeployEphemeralInput = z.object({
  eventsBaseUrl: z
    .string()
    .trim()
    .url()
    .default(DEFAULT_EVENTS_BASE_URL)
    .describe("Events base URL"),
  eventsProjectSlug: z
    .string()
    .trim()
    .min(1)
    .default("ephemeral")
    .describe("Events project slug for the ephemeral worker"),
  egressProxy: z.string().trim().url().optional().describe("External egress proxy URL"),
});

const EventStreamTerminalInput = z.object({
  projectSlug: z.string().trim().min(1).describe("Events project slug"),
  streamPath: z.string().trim().min(1).describe("Events stream path, e.g. /agents/demo"),
});

export const router = {
  streamTui: os
    .input(EventStreamTerminalInput)
    .meta({
      description: "Open a minimal OpenTUI event stream viewer",
    })
    .handler(async ({ input }) => {
      const scriptPath = join(scriptsDir, "event-stream-terminal.ts");
      // OpenTUI is currently Bun-only: https://opentui.com/docs/getting-started/
      await runInheritedProcess("bun", [
        scriptPath,
        "--events-base-url",
        DEFAULT_EVENTS_BASE_URL,
        "--project-slug",
        input.projectSlug,
        "--stream-path",
        input.streamPath,
      ]);

      return { ok: true as const };
    }),

  deployEphemeral: os
    .input(DeployEphemeralInput)
    .meta({
      description:
        "Deploy an ephemeral Cloudflare Worker, print its URL, and tear it down on Ctrl+C. Requires ALCHEMY_STATE_TOKEN (from prd doppler config).",
    })
    .handler(async ({ input, signal }) => {
      await using worker = await createEphemeralWorker({
        eventsBaseUrl: input.eventsBaseUrl.replace(/\/+$/, ""),
        eventsProjectSlug: input.eventsProjectSlug,
        egressProxy: input.egressProxy,
      });

      console.info(`\n  Ephemeral worker ready:\n`);
      console.info(`    URL:   ${worker.url}`);
      console.info(`    Stage: ${worker.stage}\n`);
      console.info(`  Ctrl+C to tear down.\n`);

      await waitForAbort(signal);

      console.info("\nTearing down...");

      return { ok: true as const, url: worker.url, stage: worker.stage };
    }),

  tunnel: os
    .input(TunnelInput)
    .meta({
      description:
        "Acquire a Cloudflare tunnel lease, open it, and subscribe an events.iterate.com stream to your local agents dev server",
    })
    .handler(async ({ input, signal }) => {
      const slug = randomBytes(4).toString("hex");
      const streamPath = StreamPath.parse(input.streamPath ?? `/dev/${slug}`);
      const projectSlug = ProjectId.parse(input.projectSlug);
      const eventsBaseUrl = input.eventsBaseUrl.replace(/\/+$/, "");
      const runnerInstance = input.runnerInstance ?? streamPathToAgentInstance(streamPath);
      const subscriptionSlug = input.subscriptionSlug ?? `dev-${slug}`;

      console.info("[tunnel] Acquiring Cloudflare tunnel lease from Semaphore…");
      await using lease = await useCloudflareTunnelLease({});

      console.info(`\n[tunnel] Lease acquired:`);
      console.info(`  Public URL:  ${lease.publicUrl}`);
      console.info(`  Local port:  ${lease.localPort}`);
      console.info(`  Pool slug:   ${lease.slug}`);
      console.info(`\n[tunnel] >>> Start your agents dev server on port ${lease.localPort} now.`);
      console.info(
        `[tunnel]     (e.g. \`PORT=${lease.localPort} pnpm dev\` — the healthcheck below waits up to ${TUNNEL_READY_TIMEOUT_MS / 1000}s.)\n`,
      );

      await using tunnel = await useCloudflareTunnel({
        token: lease.tunnelToken,
        publicUrl: lease.publicUrl,
        timeoutMs: TUNNEL_READY_TIMEOUT_MS,
      });

      const callbackUrl = buildCodemodeStreamProcessorRunnerWebSocketCallbackUrl({
        publicOrigin: tunnel.publicUrl,
        runnerInstance,
        streamPath,
      });

      const subscriptionEvent = {
        type: "events.iterate.com/core/subscription-configured",
        payload: {
          slug: subscriptionSlug,
          type: "websocket" as const,
          callbackUrl,
        },
      };

      const eventsClient = createEventsOrpcClient({
        baseUrl: eventsBaseUrl,
        projectSlug,
      });
      const appendResult = await eventsClient.append({
        path: streamPath,
        event: subscriptionEvent,
      });

      const streamViewerUrl = buildStreamViewerUrl({
        eventsBaseUrl,
        projectSlug,
        streamPath,
      });
      const appendUrl = buildStreamAppendUrl({
        eventsBaseUrl,
        projectSlug,
        streamPath,
      });

      console.info(`\n[tunnel] Subscription appended:`);
      console.info(`  Stream path:   ${streamPath}`);
      console.info(`  Stream UI:     ${streamViewerUrl}`);
      console.info(`  Append URL:    ${appendUrl}`);
      console.info(`  Callback URL:  ${callbackUrl}`);
      console.info(
        `  Event:         offset=${appendResult.event.offset} createdAt=${appendResult.event.createdAt}`,
      );
      console.info(
        `\n[tunnel] Tunnel is up. Ctrl+C to release the Semaphore lease and shut down.\n`,
      );

      await waitForAbort(signal);

      console.info(`[tunnel] Shutting down cloudflared and releasing lease…`);

      return {
        ok: true as const,
        publicUrl: tunnel.publicUrl,
        streamPath,
        streamViewerUrl,
        callbackUrl,
        subscriptionSlug,
      };
    }),
};

async function runInheritedProcess(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode ?? "unknown"}.`);
  }
}
