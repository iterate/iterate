// `iterate/processors` — the PURE stream-processor machinery: contracts,
// the processor base class, the runner (two-cursor drive), the keepalive
// state machine, and the wire types shared with the platform's stream event sender.
// Runtime-neutral on purpose: no cloudflare:workers import anywhere in this
// graph, so node processes (tests, CLIs, tooling) can import contracts and
// processors directly. The Durable-Object HOSTING layer (registry + DO
// durability adapters) is `iterate/processors/cloudflare`; the node test
// harness is `iterate/processors/testing`.
export * from "./schemas.ts";
export * from "./rpc-types.ts";
export * from "./stream-handle.ts";
export * from "./idempotency.ts";
export * from "./processor-contracts.ts";
export * from "./stream-processor.ts";
export * from "./stream-processor-runner.ts";
export * from "./stream-processor-keepalive.ts";
export * from "./processor-host-capabilities.ts";
export * from "./event-consumption-metrics.ts";
export * from "./stream-runtime-metrics.ts";
