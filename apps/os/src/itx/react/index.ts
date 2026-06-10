// The browser/React face of itx. Import from here, not the internals:
//
//   import { ItxProvider, useItxQuery, useItxMutation, itxKey } from "~/itx/react";

export { createItxBrowserClient } from "./connection.ts";
export type { ItxBrowserClient, ItxConnectionStatus } from "./connection.ts";
export { ItxProvider } from "./provider.tsx";
export { useItxClient, useItxStatus } from "./context.ts";
export { itxKey, useItxQuery, useItxMutation } from "./hooks.ts";
export type { ItxHandle, UseItxQueryOptions, UseItxMutationOptions } from "./hooks.ts";
export { useStreamEvents } from "./use-stream-events.ts";
export type { StreamTailSnapshot, StreamTailStatus } from "./stream-tail.ts";
