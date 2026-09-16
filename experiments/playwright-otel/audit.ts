import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

/** Compare shared-object concurrency with isolated objects and sequential requests. */
export async function auditControls() {
  const native = z
    .array(
      z.object({
        name: z.string(),
        traceId: z.string(),
        spanId: z.string(),
        parentSpanId: z.string().optional(),
        probe: z.object({ traceparent: z.string() }).optional(),
      }),
    )
    .parse(JSON.parse(await readFile(new URL("evidence/otel.json", import.meta.url), "utf8")));
  const results = [];
  for (const scenario of ["shared-concurrent", "isolated-concurrent", "shared-sequential"]) {
    const calls = z
      .array(z.object({ index: z.number(), traceparent: z.string(), object: z.string() }))
      .parse(
        JSON.parse(await readFile(new URL(`evidence/${scenario}.json`, import.meta.url), "utf8")),
      );
    const connections = calls.map((call) => {
      const worker = native.find(
        (span) => span.name === "probe.worker" && span.probe?.traceparent === call.traceparent,
      );
      const durableObject = native.find(
        (span) =>
          span.name === "probe.durable-object" && span.probe?.traceparent === call.traceparent,
      );
      assert(
        worker && durableObject,
        `Waiting for native telemetry for ${scenario} request ${call.index}`,
      );
      return {
        ...call,
        workerTraceId: worker.traceId,
        durableObjectTraceId: durableObject.traceId,
        correctlyAttributed: worker.traceId === durableObject.traceId,
      };
    });
    results.push({
      scenario,
      requests: calls.length,
      misattributed: connections.filter((connection) => !connection.correctlyAttributed).length,
      connections,
    });
  }
  await writeFile(
    new URL("evidence/controls-audit.json", import.meta.url),
    JSON.stringify(results, null, 2),
  );
  return results.map(({ scenario, requests, misattributed }) => ({
    scenario,
    requests,
    misattributed,
  }));
}

/** Assert the observed topology without rewriting any recorded trace or parent IDs. */
export async function audit() {
  const Span = z.object({
    name: z.string(),
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().optional(),
    startTimeUnixNano: z.string(),
    endTimeUnixNano: z.string(),
    attributes: z
      .array(
        z.object({
          key: z.string(),
          value: z.object({ stringValue: z.string().optional(), intValue: z.number().optional() }),
        }),
      )
      .default([]),
    status: z.object({ code: z.number() }),
  });
  const batches = z
    .array(
      z.object({
        resourceSpans: z.array(
          z.object({ scopeSpans: z.array(z.object({ spans: z.array(Span) })) }),
        ),
      }),
    )
    .parse(
      JSON.parse(await readFile(new URL("evidence/playwright-otlp.json", import.meta.url), "utf8")),
    );
  const spans = batches.flatMap((batch) =>
    batch.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
  );
  const native = z
    .array(
      z.object({
        name: z.string(),
        traceId: z.string(),
        spanId: z.string(),
        parentSpanId: z.string().optional(),
        probe: z.object({ traceparent: z.string() }).optional(),
      }),
    )
    .parse(JSON.parse(await readFile(new URL("evidence/otel.json", import.meta.url), "utf8")));
  assert.equal(new Set(spans.map((span) => span.traceId)).size, 1);
  assert.equal(new Set(spans.map((span) => span.spanId)).size, spans.length);
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const attempts = spans.filter((span) =>
    span.attributes.some((attribute) => attribute.key === "test.id"),
  );
  assert.equal(attempts.length, 3);
  assert.equal(attempts.filter((span) => span.status.code === 2).length, 1);
  for (const span of spans) if (span.parentSpanId) assert(byId.has(span.parentSpanId));
  for (const attempt of attempts)
    assert.equal(byId.get(attempt.parentSpanId || "")?.name, "playwright command");
  const initial = attempts.filter((span) =>
    span.attributes.some(
      (attribute) => attribute.key === "test.retry" && attribute.value.intValue === 0,
    ),
  );
  assert.equal(initial.length, 2);
  assert(
    BigInt(initial[0].startTimeUnixNano) < BigInt(initial[1].endTimeUnixNano) &&
      BigInt(initial[1].startTimeUnixNano) < BigInt(initial[0].endTimeUnixNano),
    "Initial test attempts overlap",
  );

  const requests = spans.filter((span) => span.name.endsWith("HTTP GET"));
  assert.equal(requests.length, 3);
  const connections = requests.map((request) => {
    assert(attempts.some((attempt) => attempt.spanId === request.parentSpanId));
    const worker = native.find(
      (span) =>
        span.name === "probe.worker" &&
        span.probe?.traceparent === `00-${request.traceId}-${request.spanId}-01`,
    );
    assert(worker, "Cloudflare received this exact client span's traceparent");
    assert.notEqual(
      worker.traceId,
      request.traceId,
      "Current account starts a separate native trace",
    );
    const chain = native.filter((span) => span.traceId === worker.traceId);
    const root = chain.find((span) => !span.parentSpanId);
    assert(root);
    assert.equal(chain.filter((span) => !span.parentSpanId).length, 1);
    const durableObject = native.find(
      (span) =>
        span.name === "probe.durable-object" &&
        span.probe?.traceparent === worker.probe?.traceparent,
    );
    assert(durableObject);
    let ancestor = durableObject;
    const ancestors = new Set<string>();
    while (ancestor.parentSpanId) {
      assert(!ancestors.has(ancestor.spanId), "No cycle");
      ancestors.add(ancestor.spanId);
      const parent = native.find(
        (span) => span.spanId === ancestor.parentSpanId && span.traceId === ancestor.traceId,
      );
      assert(parent, "Native parent exists");
      ancestor = parent;
    }
    const durableObjectCorrectlyAttributed = ancestors.has(worker.spanId);
    return {
      client: request.name,
      clientTraceId: request.traceId,
      clientSpanId: request.spanId,
      testAttemptSpanId: request.parentSpanId,
      nativeTraceId: worker.traceId,
      nativeRootSpanId: root.spanId,
      nativeSpanCount: chain.length,
      durableObjectTraceId: durableObject.traceId,
      durableObjectCorrectlyAttributed,
    };
  });
  const result = {
    playwrightSpanCount: spans.length,
    attempts: attempts.length,
    concurrentInitialAttempts: true,
    failedAttemptsPreserved: true,
    nativePropagationEnabled: false,
    connections,
    allDurableObjectsCorrectlyAttributed: connections.every(
      (connection) => connection.durableObjectCorrectlyAttributed,
    ),
  };
  await writeFile(new URL("evidence/audit.json", import.meta.url), JSON.stringify(result, null, 2));
  return result;
}
