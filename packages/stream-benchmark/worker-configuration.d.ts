/* Generated for stream-benchmark; refresh with: pnpm wrangler types */

interface Env {
  STREAM: DurableObjectNamespace<import("./src/stream/v0/stream.js").Stream>;
  STREAM_V1: DurableObjectNamespace<import("./src/stream/v1/stream.js").StreamV1>;
  STREAM_PROCESSOR: DurableObjectNamespace<
    import("./src/stream/v1/stream-processor.js").StreamProcessor
  >;
  BENCHMARK_DRIVER: DurableObjectNamespace<
    import("./findings/harness/benchmark-driver.js").BenchmarkDriver
  >;
  METRICS: AnalyticsEngineDataset;
  ENV_NAME: string;
  /** Set via `wrangler secret put CF_API_TOKEN` to enable GET /metrics charts. */
  CF_API_TOKEN?: string;
  /** 32-char account id; defaults can be set in wrangler vars after deploy. */
  CF_ACCOUNT_ID?: string;
}
