// Types for the SDK module os-next injects as "./processor.js" into every loaded isolate that
// imports it (src/context/worker-loader.ts). The runtime module is the `iterate/next/sdk` bundle
// (scripts/vite-plugin-processor-sdk.ts); this shim lets the example typecheck against the same surface.
export * from "iterate/next/sdk";
