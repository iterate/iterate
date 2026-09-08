# project-worker — the clean-room platform, ONE worker

One Cloudflare Worker, one package: `src/worker.ts` is the stateless edge (capnweb at `/api`,
project-host ingress `<app>--<projectId>.<base>`, the fetch lane) with the control plane in-process
as its catch-all (`src/control-plane/`: OAuth AS + a D1 directory + `/mcp` + the console);
`src/iterate-context-durable-object.ts` is THE CONTEXT — one Durable Object per `{ projectId, path }`
holding the event log, the core reduce, subscription delivery, the facets, the rpc-stub pagers and
the egress door. Everything a client does is one dotted expression on `itx`.

```ts
using api = newWebSocketRpcSession("wss://<worker>/api"); // the client's only dependency: capnweb
const session = api.authenticate(); // the request's identity, or { projectToken }
const itx = await session.projects.create({ slug: "my-project" }); // → the project's root context
await itx.append({ type: "note", payload: { n: 1 } });
```

## Read next

- `docs/itx-surface-as-built.md` — every signature, transcribed from source (start here)
- `docs/clean-room-api-walkthrough.md` — the long-form walkthrough, module by module
- `docs/design-onion-subscriptions-processors.md` — the design of record for subscriptions + processors
- `LAYERS.md` — the layer map; `BUILD-LOG.md` — what landed, when, and the proofs
- `docs/plan-v4-features-layered-on-v3.md` — the roadmap (its STATUS block says what is done)

## Run

```bash
pnpm test                       # every lane: unit (node), workers (workerd), e2e (one real worker), bench
pnpm e2e                        # the wire lane alone, against a local worker
WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e   # the proof that counts (needs PROJECT_TOKEN_SECRET)
pnpm run typecheck && pnpm run deploy
```
