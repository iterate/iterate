// The browser/React face of itx. Import from here, not the internals:
//
//   import { ItxProvider, useItxQuery, useItxMutation, itxKey } from "~/itx/react";

export { ItxProvider } from "./provider.tsx";
export { itxKey, useItxQuery, useItxMutation } from "./hooks.ts";
export { useStreamEvents } from "./use-stream-events.ts";
