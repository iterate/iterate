/**
 * Worker (or DO) opens a WebSocket to a Stream DO via stub.fetch + Upgrade.
 * https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 */

import type { Stream } from "../../src/stream/v0/stream.js";
import type { AppendBenchmarkResult } from "./types.js";
import { pumpAppendBenchmark } from "./websocket-pump.js";

export async function runWorkerWebSocketBenchmark(args: {
  streamStub: DurableObjectStub<Stream>;
  path: string;
  messages: number;
  waitForEvents?: boolean;
}): Promise<AppendBenchmarkResult> {
  const runId = crypto.randomUUID();
  const waitForEvents = args.waitForEvents ?? true;
  const url = `http://benchmark${args.path}?after=end`;

  const response = await args.streamStub.fetch(url, {
    method: "GET",
    headers: { Upgrade: "websocket" },
  });

  if (response.status !== 101) {
    throw new Error(`Expected 101 Switching Protocols, got ${response.status}`);
  }

  const ws = response.webSocket;
  if (!ws) {
    throw new Error("Missing webSocket on upgrade response");
  }

  ws.accept();

  const stats = await pumpAppendBenchmark({
    ws,
    messages: args.messages,
    runId,
    processorSlug: "benchmark-worker-ws",
    waitForEvents,
    startImmediately: true,
  });

  return {
    mode: waitForEvents ? "worker-websocket-echo" : "worker-websocket-send-only",
    path: args.path,
    messages: args.messages,
    ...stats,
  };
}
