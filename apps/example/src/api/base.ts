import { implement } from "@orpc/server";
import { exampleContract } from "@iterate-com/example-contract";
import { withRequestLogger } from "@iterate-com/shared/apps/middleware";
import type { ExampleInitialOrpcContext } from "./context.ts";

// This is the app-local oRPC composition point:
// - `exampleContract` is the typed schema for the RPC surface
// - `implement(exampleContract)` creates the contract-bound builder
// - `$context(...)` declares the pre-middleware request context
// - `router.ts` later uses `os.router({...})` to attach concrete handlers
// - `withRequestLogger()` grows execution context with requestId/logger for
//   downstream handlers: https://orpc.dev/docs/middleware
export const os = implement(exampleContract)
  .$context<ExampleInitialOrpcContext>()
  .use(withRequestLogger());
