// Minimal Node-side stand-in for the `cloudflare:workers` module, aliased in
// apps/os/vitest.config.ts. It exists so the pure itx core (src/itx/itx.ts)
// — whose ONLY platform dependency is the RpcTarget base class — can be unit
// tested without workerd (src/itx/itx.test.ts). Deliberately exports nothing
// else: any other cloudflare:workers import reaching a Node test fails loudly
// instead of being silently faked.

export class RpcTarget {}
