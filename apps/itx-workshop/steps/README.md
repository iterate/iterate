# itx, built incrementally — one runnable step per folder

This is the workshop as a **buildable progression**. Each folder is one step: a
**minimal, self-contained, well-documented** version of itx at that stage. The
one Worker (`../server.ts`) mounts every step under `/steps/<id>/*`, so earlier
and half-finished steps stay live alongside the finished ones — you can point a
client at any step and see exactly what it could do at that point.

Each step folder holds:

- `worker.ts` — the minimal server for this step (a Worker handler + any Durable
  Objects it introduces). Heavily commented; nothing it doesn't need.
- `intent.test.ts` — the **intent test**: a tiny client that states, as runnable
  assertions, what this step is _for_. Run against `wrangler dev` (`npm run dev`).
- `README.md` — what this step adds over the previous one, and the one failure it
  buys you out of.

The shared client library lives in `../client.ts` (`withItx`) + `../client-lib.ts`
(`connect`). The narrative explainer is `../itx-explainer.md`.

## The steps

| Step | Folder                   | Adds                                                                                                                                 |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 01   | `01-socket`              | a method call over a Cap'n Web socket — the whole primitive                                                                          |
| 02   | `02-server-calls-client` | bidirectional stubs: the server calls back a capability the client passed                                                            |
| 03   | `03-provide-invoke`      | `provide`/`invoke` — a runtime capability registry                                                                                   |
| 04   | `04-durable-object`      | the registry in a Durable Object; two clients rendezvous on a live cap                                                               |
| 05   | `05-dynamic-proxy`       | the server-side dynamic proxy: naked-stub deep paths + a real SDK, no client proxy                                                   |
| 06   | `06-live-vs-sturdy`      | the two capability kinds: a live stub vs a serializable address                                                                      |
| 07   | `07-streamprocessor`     | the context IS a durable event log folded by the real `@iterate-com/streams` StreamProcessor, delivered by the stream's subscription |
| 08   | `08-auth`                | an auth token → the projects you may access → an itx scoped to them                                                                  |
| 09   | `09-dial`                | `dial`: real code-loading via the Worker Loader (run an entrypoint from a ref)                                                       |
| 10   | `10-project-fetch`       | a **Project Durable Object** with a `fetch` method, provided as `itx.fetch`                                                          |
| 11   | `11-chain`               | the context chain: a project itx → an agent itx, with `extend`/`super`                                                               |
| 12   | `12-codemode`            | the flourish: `script-execution-requested`/`-completed`, run a program in a loaded isolate                                           |

Order is cumulative in spirit, but each folder runs on its own. Steps 01–07 are
the core (already proven in `../server.ts` + `../harness.ts`); 08–12 are the
platform layers. The bar for "done": each step **actually runs** (intent test
green over real workerd) and the explainer tells its story **coherently** — not
edge-case hardening or production paranoia.
