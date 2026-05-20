export { Stream } from "./stream/v0/stream.js";
export { StreamV1 } from "./stream/v1/stream.js";
export { StreamProcessor } from "./stream/v1/stream-processor.js";
export { BenchmarkDriver } from "../findings/harness/benchmark-driver.js";
import {
  buildChaosPaths,
  killOne,
  runChaosLoop,
  type ChaosBinding,
} from "../findings/harness/chaos.js";
import { runRpcAppendBenchmark } from "../findings/harness/rpc-from-worker.js";
import { runV1SubscriberProof } from "../findings/harness/v1-subscriber-proof.js";
import { runWorkerWebSocketBenchmark } from "../findings/harness/websocket-from-worker.js";
import { renderMetricsPage } from "./metrics.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/metrics") {
      return renderMetricsPage(env);
    }

    if (url.pathname === "/benchmark/ws") {
      const messages = Number(url.searchParams.get("messages") ?? "10000");
      const path = url.searchParams.get("path") ?? "/bench-findings-worker-ws";
      const stub = env.STREAM.getByName(path);
      const result = await runWorkerWebSocketBenchmark({
        streamStub: stub,
        path,
        messages,
        waitForEvents: true,
      });
      return Response.json(result);
    }

    if (url.pathname === "/benchmark/driver-ws") {
      const messages = Number(url.searchParams.get("messages") ?? "10000");
      const path = url.searchParams.get("path") ?? "/bench-findings-driver-ws";
      const driver = env.BENCHMARK_DRIVER.getByName("default");
      const result = await driver.runWebSocketBenchmark({
        targetPath: path,
        messages,
      });
      return Response.json(result);
    }

    if (url.pathname === "/benchmark/rpc") {
      const messages = Number(url.searchParams.get("messages") ?? "10000");
      const batchSize = Number(url.searchParams.get("batch") ?? "1");
      const path = url.searchParams.get("path") ?? "/bench-findings-rpc-serial";
      const stub = env.STREAM.getByName(path);
      const result = await runRpcAppendBenchmark({
        stream: stub,
        messages,
        batchSize,
        path,
      });
      return Response.json(result);
    }

    if (url.pathname === "/benchmark/v1-subscriber") {
      const runId = crypto.randomUUID();
      const streamPath = url.searchParams.get("path") ?? `/v1/bench-subscriber-${runId}`;
      const stub = env.STREAM_V1.getByName(streamPath);
      const result = await runV1SubscriberProof({ stream: stub, streamPath });
      return Response.json(result, { status: result.ok ? 200 : 500 });
    }

    if (url.pathname === "/chaos/kill" && request.method === "POST") {
      const binding = parseChaosBinding(url.searchParams.get("binding"));
      const path = url.searchParams.get("path");
      if (!path) {
        return Response.json({ error: "path query param required" }, { status: 400 });
      }
      const attempt = await killOne({
        env,
        binding,
        path,
        reason: url.searchParams.get("reason") ?? "chaos",
      });
      return Response.json(attempt);
    }

    if (url.pathname === "/chaos/run" && request.method === "POST") {
      const body = (await request.json()) as {
        binding?: ChaosBinding;
        pathPrefix?: string;
        pathCount?: number;
        durationMs?: number;
        intervalMs?: number;
        killsPerTick?: number;
        reason?: string;
      };
      const binding = body.binding ?? "stream";
      const paths = buildChaosPaths({
        pathPrefix: body.pathPrefix ?? "/bench-chaos",
        count: body.pathCount ?? 10,
      });
      const result = await runChaosLoop({
        env,
        binding,
        paths,
        durationMs: body.durationMs ?? 60_000,
        intervalMs: body.intervalMs ?? 3_000,
        killsPerTick: body.killsPerTick ?? 1,
        reason: body.reason ?? "chaos",
      });
      return Response.json({
        binding,
        paths,
        ...result,
        killed: result.attempts.length,
      });
    }

    if (url.pathname.startsWith("/v1/")) {
      return routeStreamV1(request, env, url);
    }

    const stub = env.STREAM.getByName(url.pathname);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function routeStreamV1(request: Request, env: Env, url: URL): Response | Promise<Response> {
  if (url.pathname === "/v1/processor" || url.pathname.startsWith("/v1/processor/")) {
    const processorName =
      url.pathname === "/v1/processor"
        ? url.searchParams.get("name")
        : url.pathname.slice("/v1/processor".length);
    if (processorName == null || processorName === "") {
      return new Response("Expected processor durable object name", { status: 400 });
    }
    return env.STREAM_PROCESSOR.getByName(processorName).fetch(request);
  }

  return env.STREAM_V1.getByName(url.pathname).fetch(request);
}

function parseChaosBinding(value: string | null): ChaosBinding {
  if (value === "stream-v1" || value === "stream-processor") return value;
  return "stream";
}
