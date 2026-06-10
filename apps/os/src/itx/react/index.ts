// The browser/React face of itx. Import from here, not the internals:
//
//   import { ItxProvider, useItxQuery, useItxMutation, itxKey } from "~/itx/react";

export { ItxProvider } from "./provider.tsx";
export { useItxClient } from "./context.ts";
export { itxKey, useItxQuery, useItxMutation, type ItxHandle } from "./hooks.ts";
export { useStreamEvents } from "./use-stream-events.ts";
export { getItxErrorCode, isItxAccessError, type ItxErrorCode } from "./errors.ts";
