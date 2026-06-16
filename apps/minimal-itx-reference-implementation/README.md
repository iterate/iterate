# minimal-itx-reference-implementation

A single, minimal, coherent reference implementation of **itx** — Iterate's
capability layer over Cap'n Web. A context is the fold of a durable event log,
served over a naked Cap'n Web stub against real workerd + a real `Stream`
Durable Object.

Read **[DESIGN.md](./DESIGN.md)** for the model and the file map.

## Run

```bash
pnpm install
npm run typecheck        # tsc --noEmit
npm run dev              # terminal 1: wrangler dev (real workerd) on :8788
npm run e2e              # terminal 2: the Node client harness, ✓/✗ per concept
```

`npm run e2e` needs `npm run dev` running. It exercises, end to end: live
capabilities, dynamic workers, a repo-backed dynamic Durable Object facet from
`counter.js`, trusted Durable Object built-ins, deep dotted paths +
longest-prefix shadowing, the parent chain, the stateless `__global__` root, auth at
the connect door, and codemode.

## Connect

```ts
import { withItx } from "./client.ts";

using itx = withItx({ projectId: "shared", path: "/", token: "alice-token" });
await itx.provideCapability({ path: ["greeter"], capability: (n) => `hi ${n}` });
await itx.greeter("alice"); // "hi alice" — naked deep path, no client library
```

The HTTP shape is `projectId` plus `path`: `projectId=shared&path=/` opens the
project context, `projectId=shared&path=/agents/alice` opens an agent context,
and empty `projectId` opens the `__global__` root.

## Curl

`POST` runs a script against the same selected context and records
`script-execution-requested` / `script-execution-completed` in the folded state:

```bash
curl -sS \
  -H 'authorization: Bearer alice-token' \
  -H 'content-type: text/plain' \
  --data 'async () => "hello from curl"' \
  'http://127.0.0.1:8788/api/itx?projectId=shared&path=/'
```
