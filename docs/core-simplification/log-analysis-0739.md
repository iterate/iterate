# 0739 Workers Logs analysis

Window: `2026-09-30T06:30:00Z`–`2026-09-30T06:48:54Z`.
Raw read-only query outputs: `logs-main-0739-final.json`, `logs-pr3461-2688ca9-8services.json`, and the separate soak exercise `logs-preview-0739-final.json`. The query read `error` and `warn` entries for each worker independently; services with zero entries are recorded in those files.

| Target                              | Services queried                                                          | Errors | Warnings | Assessment                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------- | -----: | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main                                | `os-prd`, `admin`, `agents`, `dash`, `docs`, `kiterate`, `notes`, `voice` |      0 |       10 | The 10 `os-prd` warnings are the known pager re-dial heal: “a lent stub's pager dropped … back in service”.                                                               |
| PR preview (verified deployments)   | `pr3461-2688ca9-{os,admin,agents,dash,docs,kit,notes,voice}`              |    131 |      444 | Cloudflare Scripts API verified all eight names. Only `pr3461-2688ca9-os` had entries; do not call this window clean without reviewing its probe/error groups.            |
| soak exercise (separate deployment) | `soak-cs-3461-0739-0739e06-os`                                            |    139 |      770 | This is the 100-run soak worker, not a PR client deployment. Known test probes dominate, but several platform/runtime groups require the terminal soak result and review. |

## Soak-exercise groups with a direct test or source correlation

- **59 errors**: external `GET` validation probes (`egress.invalid`, `dummy-petshop`, `cap.internal`, etc.); they are exercised by fetch/connection E2E rows.
- **55 errors**: explicit `itx.abort()` reset paths, including deploy and physical reset variants.
- **3 errors**: Cloudflare’s “Internal error in Durable Object storage caused object to be reset” with one `IterateContextDurableObject.jsrpc` wrapper. This exact message is pinned by `e2e/facet-abort-storage-reset.e2e.test.ts` and recovered by the runtime.
- **2 errors**: `DataCloneError` for the deliberately WebSocket-bearing `itx.wsdyn` expression. `e2e/fetch.e2e.test.ts` tests that Workers RPC cannot serialize that response.
- **1 error**: `scheduled-append.failed`, `FORBIDDEN`, after a jail rejects the `lift` schedule. `e2e/loaded-code.e2e.test.ts` explicitly checks that a jail cannot be lifted “by neither its code nor a schedule”; the runtime records the failed schedule rather than retrying it.
- **310 warnings**: delivery in-flight-budget drops. `e2e/isolate-ceilings-slow-client.e2e.test.ts` deliberately drives that condition and asserts that the subscriber heals by reading.
- **28 warnings**: structured OAuth refusals.
- **6 warnings**: bounded alarm re-arm heals.
- **2 warnings**: pager re-dial heals.

## Groups that remain unclassified for the checkpoint

- **18 errors**: `SecretDurableObject.jsrpc` (17) and `WorkspaceDurableObject.jsrpc` (1) exception wrappers carry no source message in Workers Logs. They occurred alongside the full E2E exercise, but the wrapper alone does not establish which test expected it.
- **72 warnings**: Cloudflare `waitUntil()` cancellation under E2E load. These are runtime-level cancellations on `/api`; they must not be treated as product success without the soak’s durable assertions.
- **351 warnings**: `Error: Network connection lost`; likely the intentional live-client closure path, but not individually attributed in the query.
- **1 warning**: Cloudflare `internal error; reference = …`, also not attributable from the query alone.

The automatic Preview OS E2E job independently passed 54 files / 329 tests on the merge deployment, and its slow rows passed. The verified PR preview inventory is `pr3461-2688ca9-{os,admin,agents,dash,docs,kit,notes,voice}`, with 131 errors / 444 warnings on its OS worker and zero entries on its seven apps. The final 100-run soak is still active, so the separate soak snapshot is evidence to reconcile with its per-run JSON, not a clean-log claim.
