import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { context, propagation, trace } from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

/** Local proof of the cross-process topology; these are not real Depot workflow/job spans. */
export async function run() {
  const batches: unknown[] = [];
  const collector = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    batches.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("Expected local TCP collector");
  const endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({ url: endpoint }))],
  });
  provider.register();
  const tracer = trace.getTracer("playwright-otel-probe");
  const workflow = tracer.startSpan("local workflow proof");
  const job = tracer.startSpan(
    "local shard job proof",
    {},
    trace.setSpan(context.active(), workflow),
  );
  const step = tracer.startSpan("playwright command", {}, trace.setSpan(context.active(), job));
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), step), carrier);
  try {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "probe.spec.ts",
        "--config",
        "experiments/playwright-otel/playwright.config.ts",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          PROBE_TRACEPARENT: carrier.traceparent,
          PROBE_OTLP_ENDPOINT: endpoint,
        },
      },
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    if (exitCode !== 0) throw new Error(`Playwright exited ${exitCode}`);
  } finally {
    step.end();
    job.end();
    workflow.end();
    await provider.shutdown();
    await new Promise<void>((resolve, reject) =>
      collector.close((error) => (error ? reject(error) : resolve())),
    );
    await writeFile(
      new URL("evidence/playwright-otlp.json", import.meta.url),
      JSON.stringify(batches, null, 2),
    );
  }
  return { traceId: workflow.spanContext().traceId, batches: batches.length };
}
