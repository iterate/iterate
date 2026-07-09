// `iterate/sdk` — what an iterate project repo imports from.
//
// The platform's public capability types (Project, Stream, StreamEvent,
// ItxBinding, …) are generated from the platform's RpcTargets into
// ./itx-api.generated.ts (regenerate from apps/os: `pnpm generate:itx-api`)
// and re-exported here. Hand-written helpers for project code accumulate in
// this file.
// Extensionless on purpose: this specifier lands verbatim in the published
// dist/sdk.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated";
