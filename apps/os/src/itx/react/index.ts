// The browser/React face of itx. Import from here, not the internals:
//
//   import { ItxProvider, useItxQuery, useItxMutation, itxKey } from "~/itx/react";

export { createItxBrowserClient } from "./connection.ts";
export type { ItxBrowserClient, ItxConnectionStatus } from "./connection.ts";
export { ItxProvider, useItxClient, useItxStatus } from "./provider.tsx";
export { itxKey, useItxQuery, useItxMutation } from "./hooks.ts";
export type { ItxHandle, UseItxQueryOptions, UseItxMutationOptions } from "./hooks.ts";
