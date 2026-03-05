#!/usr/bin/env tsx
/**
 * Standalone egress proxy — thin wrapper around @iterate-com/mock-http-proxy.
 *
 * Starts an HTTP proxy that can record traffic to HAR, replay from a HAR
 * archive, or just forward (bypass) everything. Runs until Ctrl+C.
 *
 * Usage:
 *   tsx jonasland/scripts/external-egress-proxy.ts
 *   tsx jonasland/scripts/external-egress-proxy.ts --port 9090
 *   tsx jonasland/scripts/external-egress-proxy.ts --record out.har
 *   tsx jonasland/scripts/external-egress-proxy.ts --replay traffic.har
 *   tsx jonasland/scripts/external-egress-proxy.ts --replay traffic.har --unhandled error
 *   tsx jonasland/scripts/external-egress-proxy.ts --quiet
 *
 * Flags:
 *   --port <n>             Port to listen on (default: 0 = random)
 *   --host <addr>          Bind address (default: 0.0.0.0)
 *   --record <path>        Record traffic to a HAR file
 *   --replay <path>        Replay responses from a HAR archive
 *   --unhandled <mode>     Behavior for requests not in the replay archive:
 *                            bypass (default) — forward to upstream
 *                            warn   — forward, but log a warning
 *                            error  — reject with 500
 *   --quiet                Suppress per-request log lines
 */
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import {
  fromTrafficWithWebSocket,
  useMockHttpServer,
  type HarWithExtensions,
  type UseMockHttpServerOptions,
} from "../../packages/mock-http-proxy/src/index.ts";

type UnhandledMode = "bypass" | "warn" | "error";

function parseArgs(argv: string[]) {
  let port = 0;
  let host = "0.0.0.0";
  let recordPath: string | undefined;
  let replayPath: string | undefined;
  let unhandled: UnhandledMode = "bypass";
  let quiet = false;
  let verbose = true;
  let maxBody = 2000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === "--port" || arg === "-p") && argv[i + 1]) {
      port = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--port=")) {
      port = Number.parseInt(arg.slice("--port=".length), 10);
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i]!;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--record" && argv[i + 1]) {
      recordPath = argv[++i]!;
    } else if (arg.startsWith("--record=")) {
      recordPath = arg.slice("--record=".length);
    } else if (arg === "--replay" && argv[i + 1]) {
      replayPath = argv[++i]!;
    } else if (arg.startsWith("--replay=")) {
      replayPath = arg.slice("--replay=".length);
    } else if (arg === "--unhandled" && argv[i + 1]) {
      unhandled = argv[++i]! as UnhandledMode;
    } else if (arg.startsWith("--unhandled=")) {
      unhandled = arg.slice("--unhandled=".length) as UnhandledMode;
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--max-body" && argv[i + 1]) {
      maxBody = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--max-body=")) {
      maxBody = Number.parseInt(arg.slice("--max-body=".length), 10);
    }
  }

  if (!["bypass", "warn", "error"].includes(unhandled)) {
    console.error(`Invalid --unhandled mode: ${unhandled} (expected bypass|warn|error)`);
    process.exit(1);
  }

  return { port, host, recordPath, replayPath, unhandled, quiet, verbose, maxBody };
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

async function main() {
  const { port, host, recordPath, replayPath, unhandled, quiet, verbose, maxBody } = parseArgs(
    process.argv.slice(2),
  );

  const serverOpts: UseMockHttpServerOptions = {
    port,
    host,
    onUnhandledRequest: unhandled,
  };

  if (recordPath) {
    serverOpts.recorder = {
      enabled: true,
      harPath: recordPath,
      includeHandledRequests: true,
      decodeContentEncodings: ["br", "gzip", "deflate"],
    };
  }

  const server = await useMockHttpServer(serverOpts);

  function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}… (${text.length} bytes total)`;
  }

  function formatHeaders(headers: Headers): string {
    const lines: string[] = [];
    headers.forEach((value, key) => {
      lines.push(`    ${key}: ${value}`);
    });
    return lines.join("\n");
  }

  function logVerbose(label: string, request: Request, response: Response): void {
    console.log(
      [
        `${ts()} ${label}  ${request.method} ${request.url} → ${response.status}`,
        `  ── Request headers ──`,
        formatHeaders(request.headers),
        `  ── Response headers ──`,
        formatHeaders(response.headers),
        "",
      ].join("\n"),
    );
  }

  if (!quiet) {
    server.events.on(
      "response:mocked",
      ({ request, response }: { request: Request; response: Response }) => {
        if (verbose) {
          void logVerbose("REPLAY", request, response);
        } else {
          console.log(`${ts()} REPLAY  ${request.method} ${request.url} → ${response.status}`);
        }
      },
    );
    server.events.on(
      "response:bypass",
      ({ request, response }: { request: Request; response: Response }) => {
        if (verbose) {
          void logVerbose("BYPASS", request, response);
        } else {
          console.log(`${ts()} BYPASS  ${request.method} ${request.url} → ${response.status}`);
        }
      },
    );
    server.events.on("request:unhandled", ({ request }: { request: Request }) => {
      if (unhandled === "error") {
        console.log(`${ts()} REJECT  ${request.method} ${request.url}`);
      }
    });
  }

  if (replayPath) {
    const har = JSON.parse(await readFile(replayPath, "utf8")) as HarWithExtensions;
    const entryCount = har.log?.entries?.length ?? 0;
    const handlers = fromTrafficWithWebSocket(har, { matchWebSocketBy: "path" });
    server.use(...handlers);
    console.log(
      `[egress-proxy] replay: ${replayPath} (${entryCount} entries, ${handlers.length} handlers)`,
    );
  }

  console.log(`[egress-proxy] listening on ${server.url}`);
  console.log(`[egress-proxy] unhandled requests: ${unhandled}`);
  if (recordPath) console.log(`[egress-proxy] recording to: ${recordPath}`);
  console.log(`[egress-proxy] Ctrl+C to stop`);

  function flushHarSync(): void {
    if (!recordPath) return;
    try {
      writeFileSync(recordPath, JSON.stringify(server.getHar(), null, 2));
      console.log(`[egress-proxy] HAR written to ${recordPath}`);
    } catch {
      // already written or server closed
    }
  }

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log("\n[egress-proxy] shutting down...");
      flushHarSync();
      await server.close();
      console.log("[egress-proxy] stopped");
      resolve();
    };

    // SIGHUP (from tmux kill) must flush synchronously — Node exits
    // immediately after the handler returns, no time for async work.
    process.once("SIGHUP", () => {
      flushHarSync();
      process.exit(0);
    });
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
