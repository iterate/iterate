/**
 * A separate Durable Object that connects to Stream via WebSocket (stub.fetch + Upgrade).
 * Tests whether the caller being a DO changes throughput vs the outer Worker route.
 */

import { DurableObject } from "cloudflare:workers";
import type { Stream } from "../../src/stream/v0/stream.js";
import { runWorkerWebSocketBenchmark } from "./websocket-from-worker.js";

export class BenchmarkDriver extends DurableObject<Env> {
  async runWebSocketBenchmark(args: { targetPath: string; messages: number }) {
    const stub = this.env.STREAM.getByName(args.targetPath);
    return runWorkerWebSocketBenchmark({
      streamStub: stub,
      path: args.targetPath,
      messages: args.messages,
      waitForEvents: true,
    });
  }
}
