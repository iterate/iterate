// apps/os/src/types.ts (the itx public contract we import types from) mentions
// the Cloudflare Workers global `ExecutionContext` in one server-only member.
// This app never touches it — the ambient alias just satisfies tsc.
type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  exports: Record<string, unknown>;
};
