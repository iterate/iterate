# Minimal ITX v4

The public Cap'n Web endpoint exports one unauthenticated target:

```ts
using unauthenticatedItx = connectItx({ baseUrl });
using itx = unauthenticatedItx.authenticate({
  auth: { type: "token", token },
  projectId: "prj_ref",
});
```

`authenticate()` is the only way to get the real ITX capability. Its input is
also the shape used by platform-provided dynamic worker bindings:

```ts
type ItxConnectInput = {
  auth:
    | { type: "token"; token: string }
    | { type: "from-server-cookie" }
    | { type: "trusted-internal"; token: string };
  projectId?: string;
  path?: string;
};
```

Omitting `projectId` returns the authenticated global ITX. Passing `projectId`
with no `path` returns the project root ITX. Passing a path such as
`/agents/ada` returns that context's ITX.

Browser-style auth can be simulated with a fake login endpoint:

```bash
curl -i -X POST http://127.0.0.1:8789/api/login --data alice-token
```

That writes an HttpOnly cookie. Browser callers then connect to `/api/itx` and
authenticate with:

```ts
using itx = unauthenticatedItx.authenticate({
  auth: { type: "from-server-cookie" },
  projectId: "prj_ref",
});
```

Dynamic workers receive an `env.ITX` binding whose props include a trusted
internal auth credential. Inside loaded code:

```ts
const itx = await env.ITX.authenticate();
```

Run the local Miniflare-backed worker and test it:

```bash
pnpm verify:miniflare
```

Run the same suite against a deployed worker:

```bash
ITX_BASE=https://your-worker.workers.dev pnpm verify:deployed
```

Open a Node REPL against a running local or deployed worker:

```bash
pnpm repl
ITX_BASE=https://your-worker.workers.dev pnpm repl
```

The REPL exposes `itx`, `root`, `RpcTarget`, `baseUrl`, `projectId`, and `token`.
Defaults are `http://127.0.0.1:8789`, project `prj_ref`, and the demo tokens
from `src/auth.ts`.

## Cloudflare Workers RPC Types

This app currently relies on the root-level `@cloudflare__workers-types.patch`.
The patch is still needed for `@cloudflare/workers-types@4.20260426.1`: upstream
types return `never` when an RPC method returns a non-serializable nested object,
but v4 passes typed capability objects over Durable Object RPC. The patch changes
that fallback to `Promise<R & MaybeDisposable<R>>`, which keeps those capability
returns usable from generated stubs.

`pnpm-workspace.yaml` applies the patch through `patchedDependencies`, so run
`pnpm install` from the repository root after changing the patch or the
`@cloudflare/workers-types` version.
