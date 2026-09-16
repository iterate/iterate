// Types for the SDK module os-next injects as "./processor.js" into every loaded isolate that
// imports it (src/context/worker-loader.ts). The runtime module is built by build-sdk.mjs from
// src/sdk/index.ts; this shim lets the example typecheck against the same surface.
export * from "../../src/sdk/index.ts";
