/**
 * Shared oRPC middleware for apps built on `defineApp`.
 *
 * The concrete middleware implementations live under `src/apps/middleware/` so each
 * helper can stay focused and discoverable. This file remains as the stable
 * import surface for app code that already imports `@iterate-com/shared/apps/middleware`.
 */
export { requireHeader } from "./middleware/require-header.ts";
export { useEvlog, useEvlog as withRequestLogger } from "./middleware/use-evlog.ts";
export type {
  AppRequestLogger,
  HeaderValuesContext,
  RequestLoggerContext,
  MissingHeaderErrorCode,
  RequireHeaderOptions,
} from "./middleware/types.ts";
