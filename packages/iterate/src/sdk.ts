// `iterate/sdk` — what an iterate project repo imports from.
//
// The platform's public capability types (Project, Stream, StreamEvent,
// ItxBinding, …) are generated from the platform's RpcTargets into
// ./itx-api.generated.ts (regenerate from apps/os: `pnpm generate:itx-api`)
// and re-exported here. Hand-written helpers for project code accumulate in
// this file.
// Extensionless on purpose: these specifiers land verbatim in the published
// dist/sdk.d.ts, where they must resolve to their dist/*.d.ts siblings.
export type * from "./itx-api.generated";

// The stream-processor machinery: define contracts and processors in project
// code with the exact runtime the platform's own processors run on. The
// platform consumes this same copy (apps/os/src/domains/streams re-exports).
export * from "./processor-contracts.ts";
export * from "./stream-processor.ts";

// The stream event envelope schemas, under Schema-suffixed names — the
// inferred TYPES already ship under their own names via the generated itx API.
export {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
  StreamListItem as StreamListItemSchema,
} from "./stream-events.ts";

// The zod instance the SDK machinery validates with. Author contract schemas
// with THIS z, so userspace payload schemas and the SDK's envelope schemas
// never come from two different zod copies.
export { z } from "zod";
