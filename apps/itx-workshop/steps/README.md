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

A ✅ row is a folder you can `cd` into and run; a ⏳ row is **not yet extracted**
into its own folder — that step's behavior is built and proven today in the
shared core (`../server.ts` + `../harness.ts`), and the folder is a TODO.

| Folder                   | Status | Adds                                                                                                                   |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `01-socket`              | ✅     | a method call over a Cap'n Web socket — the whole primitive                                                            |
| `02-server-calls-client` | ✅     | bidirectional stubs: the server calls back a capability the client passed                                              |
| `03-provide-invoke`      | ✅     | `provide`/`invoke` — a runtime capability registry (per-connection; motivates 04)                                      |
| `04-durable-object`      | ✅     | the registry in a Durable Object; two clients rendezvous on a live cap (shared `RegistryDO`)                           |
| `05-dynamic-proxy`       | ⏳     | the server-side dynamic proxy: naked-stub deep paths + a real SDK, no client proxy                                     |
| `06-live-vs-sturdy`      | ⏳     | the two capability kinds: a live stub vs a serializable address                                                        |
| `07-streamprocessor`     | ✅     | the context IS a durable event log folded by the real platform StreamProcessor, delivered by the stream's subscription |
| `08-auth`                | ✅     | an auth token → the projects you may access → an itx scoped to them                                                    |
| `09-dial`                | ✅     | `dial`: real code-loading via the Worker Loader (run an entrypoint from a ref)                                         |
| `10-project-fetch`       | ✅     | a **Project Durable Object** with a `fetch` method, provided as `itx.fetch`                                            |
| `11-chain`               | ✅     | the context chain: a project itx → an agent itx, with `extend`/`super`                                                 |
| `12-codemode`            | ✅     | the flourish: `script-execution-requested`/`-completed`, run a program in a loaded isolate                             |

The bar for "done": each step **actually runs** (intent test green over real
workerd) and its story is told **coherently** — not edge-case hardening or
production paranoia.

### Two numbering schemes — don't conflate them

This `steps/` sequence is the **runnable build order**. The narrative explainer
`../itx-explainer.md` has its own **prose** step numbers (0–13) that do NOT line
up one-to-one — it spends Steps 8–11 on the StreamProcessor that is one folder
here (`07`), and folds auth/dial/project/chain/codemode into its Step 12.
Crosswalk:

| `steps/` folder                                               | explainer prose           |
| ------------------------------------------------------------- | ------------------------- |
| 01 socket                                                     | Step 0                    |
| 02 server-calls-client                                        | Step 1                    |
| 03 provide-invoke                                             | Step 2                    |
| 04 durable-object                                             | Steps 3–4                 |
| 05 dynamic-proxy                                              | Steps 5–6                 |
| 06 live-vs-sturdy                                             | Step 7                    |
| 07 streamprocessor                                            | Steps 8–11                |
| 08 auth · 09 dial · 10 project-fetch · 11 chain · 12 codemode | Step 12 (platform layers) |

(`validate-steps.mjs` prints the **explainer** numbers; the intent tests use the
**folder** numbers. Same idea, two labels.)
