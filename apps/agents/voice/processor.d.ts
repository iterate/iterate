// Types for the SDK module apps/os injects as "./processor.js" into every loaded isolate that
// imports it (apps/os/src/context/worker-loader.ts). The runtime module is the `iterate/next/sdk`
// bundle; this shim types this app's loaded voice code against `iterate/next/sdk`.
export * from "iterate/next/sdk";
