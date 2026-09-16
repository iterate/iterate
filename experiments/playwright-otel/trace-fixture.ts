import { readFile } from "node:fs/promises";
import { test as base, type APIRequestContext, type Request } from "@playwright/test";
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export const test = base.extend<{
  probe: { url: string; apiRequest: (request: APIRequestContext) => Promise<unknown> };
}>({
  probe: [
    async ({ context: browserContext }, use, info) => {
      const { key, url } = JSON.parse(
        await readFile(new URL("credentials.ignoreme.json", import.meta.url), "utf8"),
      );
      const provider = new NodeTracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor(new OTLPTraceExporter({ url: process.env.PROBE_OTLP_ENDPOINT })),
        ],
      });
      provider.register();
      const tracer = provider.getTracer("playwright-otel-probe");
      const parent = propagation.extract(context.active(), {
        traceparent: process.env.PROBE_TRACEPARENT,
      });
      const attempt = tracer.startSpan(
        info.title,
        {
          attributes: {
            "test.id": info.testId,
            "test.retry": info.retry,
            "test.worker": info.workerIndex,
          },
        },
        parent,
      );
      const testContext = trace.setSpan(parent, attempt);
      const requests = new Map<Request, Span>();

      // Target only our synthetic Worker. Routing changes cache behavior: production integration needs
      // a considered injection mechanism, not a blanket route over all origins.
      await browserContext.route(`${url}/**`, async (route) => {
        const span = tracer.startSpan("browser HTTP GET", { kind: SpanKind.CLIENT }, testContext);
        const headers = { ...route.request().headers(), "x-probe-key": key };
        propagation.inject(trace.setSpan(testContext, span), headers);
        requests.set(route.request(), span);
        await route.continue({ headers });
      });
      browserContext.on("requestfinished", async (request) => {
        const span = requests.get(request);
        if (!span) return;
        const response = await request.response();
        span.setAttribute("http.response.status_code", response?.status() || 0);
        span.end();
        requests.delete(request);
      });
      browserContext.on("requestfailed", (request) => {
        const span = requests.get(request);
        if (!span) return;
        span.setStatus({ code: SpanStatusCode.ERROR, message: "browser request failed" });
        span.end();
        requests.delete(request);
      });

      try {
        await use({
          url,
          apiRequest: async (request) => {
            const span = tracer.startSpan("API HTTP GET", { kind: SpanKind.CLIENT }, testContext);
            const headers: Record<string, string> = { "x-probe-key": key };
            propagation.inject(trace.setSpan(testContext, span), headers);
            try {
              const response = await request.get(url, { headers });
              span.setAttribute("http.response.status_code", response.status());
              return await response.json();
            } finally {
              span.end();
            }
          },
        });
      } finally {
        attempt.setAttribute("test.status", info.status || "unknown");
        if (info.status === "failed")
          attempt.setStatus({ code: SpanStatusCode.ERROR, message: "intentional probe failure" });
        for (const span of requests.values()) {
          span.setAttribute("probe.incomplete", true);
          span.end();
        }
        attempt.end();
        await provider.shutdown();
      }
    },
    { auto: true },
  ],
});
