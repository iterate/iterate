// Minimal Node-side stand-in for the `cloudflare:workers` module, aliased in
// apps/os/vitest.config.ts. It exists so the pure itx core (src/itx/itx.ts)
// — whose ONLY platform dependency is the RpcTarget base class — can be unit
// tested without workerd (src/itx/itx.test.ts). The tracing stand-in is just
// enough for observability unit tests; the preview proof still exercises the
// real Workers implementation.

export class RpcTarget {}

export const tracing = {
  enterSpan: <T>(
    _name: string,
    callback: (span: { setAttribute(name: string, value: unknown): void }) => T,
  ): T => callback({ setAttribute: () => undefined }),
};
