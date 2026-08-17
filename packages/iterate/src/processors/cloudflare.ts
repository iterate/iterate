// `iterate/processors/cloudflare` — the Durable-Object HOSTING layer:
// the per-DO registry (alarm scheduling, processor wake response, live-state assembly),
// the DO-backed durability adapters (KV progress store, keepalive
// recovery), and the facet host (`ProcessorFacet` — the same registry placed
// inside a Durable Object facet, alarms proxied to the parent). Split from the
// pure `iterate/processors` entry because this is
// the only layer that touches the Cloudflare runtime (`cloudflare:workers`
// tracing, DurableObjectState) — contracts, processors, and the runner stay
// importable from any node process (tests, CLIs) without a workerd shim.
export * from "./stream-processor-registry.ts";
export * from "./durable-object-processor-durability.ts";
export * from "./processor-facet.ts";
