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

`npm run e2e` needs `npm run dev` running. It exercises, end to end: live and
sturdy capabilities, deep dotted paths + longest-prefix shadowing, the parent
chain (an agent inheriting and shadowing its project's caps), the stateless
global root, auth at the connect door, and codemode.

## Connect

```ts
import { withItx } from "./client.ts";

using itx = withItx({ context: "prj:shared", token: "alice-token" });
await itx.provideCapability({ path: ["greeter"], capability: (n) => `hi ${n}` });
await itx.greeter("alice"); // "hi alice" — naked deep path, no client library
```

`context` is a coordinate: `prj:<id>` (project), `prj:<id>/agents/<name>`
(agent, parented to the project), or `global` (the platform root).
