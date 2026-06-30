# Minimal ITX v4

The public Cap'n Web endpoint exports one unauthenticated target:

```ts
using unauthenticatedItx = connectItx({ baseUrl });
using root = unauthenticatedItx.authenticate({
  type: "token",
  token: { type: "user", principal: "alice", projectScopes: ["prj_ref"] },
});
using project = root.projects.get("prj_ref");
```

`authenticate()` is the only way to get the real ITX capability. Its input is
also the shape used by platform-provided dynamic worker bindings:

```ts
type ItxAuthCredentials =
  | { type: "token"; token: ItxAuthToken }
  | { type: "from-server-cookie" }
  | { type: "trusted-internal"; token: string };
```

Authentication returns the root ITX catalog. From there, `root.projects.get(id)`
returns a project capability and `root.projects.create({ slug })` creates a
project. Project creation also creates and seeds the default repo at path `/`,
loads the seeded project worker from `worker.js`, and only then emits
`events.iterate.com/project/created`.

```ts
using project = root.projects.create({ slug: "demo" });

await project.repo.whoami(); // same repo as project.repos.get("/")
const response = await project.worker.fetch(new Request("https://example.com/probe"));
```

Browser-style auth can be simulated with a fake login endpoint:

```bash
curl -i -X POST http://127.0.0.1:8791/api/login --data alice-token
```

That writes an HttpOnly cookie. Browser callers then connect to `/api/itx` and
authenticate with:

```ts
using itx = unauthenticatedItx.authenticate({
  type: "from-server-cookie",
});
```

Dynamic workers receive an `env.ITX` binding whose props include a trusted
internal project/path scope. Inside loaded code:

```ts
const itx = await env.ITX.get();
```

External clients still connect to `/api/itx` and call `authenticate(...)`.
`connectItx` overloads are only client-side convenience:

```ts
using root = connectItx({ auth, baseUrl });
using project = connectItx({ auth, baseUrl, projectId: "prj_ref" });
using agent = connectItx({ agentPath: "/agents/demo", auth, baseUrl, projectId: "prj_ref" });
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
Defaults are `http://127.0.0.1:8791`, project `prj_ref`, and the demo tokens
from `src/auth.ts`.

## Stream Processor Hosting

Stream processors receive a full public `Stream` capability. A processor-hosting
Durable Object creates a trusted internal `StreamRpcTarget` for its own stream
and passes it to `createStreamProcessorHost(...)`; processors do not receive raw
Durable Object stubs.

Outbound subscription handshakes are identity-only: the stream Durable Object
tells the processor host which `subscriptionKey` to open, and the host calls
`.subscribe(...)` on its own stable stream capability. No stream capability is
passed through the handshake.

The stream Durable Object's storage methods remain implementation details.
Append/read methods that touch SQLite/KV directly stay synchronous internally;
the public `Stream` interface remains async through `StreamRpcTarget`.

## Cloudflare Workers RPC Types

This app currently relies on the root-level `@cloudflare__workers-types.patch`.
The patch is still needed for `@cloudflare/workers-types@4.20260621.1`: upstream
types return `never` when an RPC method returns a non-serializable nested object,
but v4 passes typed capability objects over Durable Object RPC. The patch changes
that fallback to `Promise<R & MaybeDisposable<R>>`, which keeps those capability
returns usable from generated stubs.

`pnpm-workspace.yaml` applies the patch through `patchedDependencies`, so run
`pnpm install` from the repository root after changing the patch or the
`@cloudflare/workers-types` version.
