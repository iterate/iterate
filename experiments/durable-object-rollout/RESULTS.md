# Recorded results — 18 September 2026

**Reproduced without Iterate code:** an object first touched after Wrangler exited
started on the old DO version, even though its caller was already on the new Worker
version. Its operation was interrupted by a code-update reset and never completed.

The test is deliberately red when a fresh operation fails. The active-object control
asserts that a reset is observed; that is separate from the fresh-object assertions.

## Full run: `26dae30f`

[Complete evidence](evidence/2026-09-18-26dae30f.json). Ran 10:05:15–10:09:05 UTC,
about 230 seconds. All 72 fresh requests started 0–2ms after Wrangler exited.
Each row below contains 12 unique first-use DO names; writes were never retried.

| Deployment        | Completed | Code-update reset | Internal error | Namespace deleted | Parked response |
| ----------------- | --------: | ----------------: | -------------: | ----------------: | --------------: |
| Ordinary 1        |        12 |                 0 |              0 |                 0 |               0 |
| Ordinary 2        |         7 |                 5 |              0 |                 0 |               0 |
| Ordinary 3        |        12 |                 0 |              0 |                 0 |               0 |
| Retire/recreate 1 |         3 |                 2 |              4 |                 2 |               1 |
| Retire/recreate 2 |         3 |                 3 |              3 |                 3 |               0 |
| Retire/recreate 3 |        11 |                 0 |              0 |                 1 |               0 |

The control also reset, leaving an unfinished durable record and changing both
boot ID and version. Node exited 1: four of the seven case subtests failed; the
parent failure makes the runner report five failures. Cleanup succeeded.

The first implementation's progress message counted HTTP 200s, so it printed
`4/12` for retire/recreate 1. One was the parked Worker and did no work. The actual
assertions rejected that response; the table counts only completed durable work.
The final test's progress message now uses the same completion condition.

### One operation, from start to failure

Operation `760d219c-ae4d-4e62-92e5-b191cb4fda32`, ordinary redeploy 2:

| Time since Wrangler exit | Observation                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0ms                      | Client first touches a newly generated object name.                                                                                                                                                                |
| 2,586ms                  | DO stores `status: started`, old build `ordinary-redeploy-1`, version `b1db1b8f-2269-437d-884b-e14a8f9a9687`, boot `49951ecf-f1de-4255-8aaa-31190d73862b`.                                                         |
| 6,590ms                  | New Worker build `ordinary-redeploy-2`, version `0ab6d55b-4bc6-4478-980b-2d183c04db7b`, returns HTTP 500: `Durable Object reset because its code was updated.` Both `durableObjectReset` and `retryable` are true. |
| 19,854ms                 | Follow-up read returns DO build `ordinary-redeploy-2`, new boot `992606b1-98d7-4840-be5b-4b490152f541`. Durable record is still `started`, with only 15 progress writes and no completion.                         |

All five ordinary-redeploy resets have this unfinished-record and changed-version/
boot evidence. None of those objects existed before the measured deploy returned.
A successful response from a new Worker version alone therefore does not establish
that the next brand-new DO will start on that version.

### What erase does and does not explain

The ordinary namespace stayed `af42e60de5bf4094bf274888dbb9d33c`. Class retirement
and recreation produced three different namespaces:
`5e38ea65d1d542bdbcda7802a016707f`, `b48a04ea44e1472e9fb5401f5c50c1f5`, then
`8b27679752c94f5197c593b0469b29bf`.

Nevertheless, some requests sent after the recreate deploy returned were served
by the **previous Worker version**, or even the intervening parked version. The
five code-update resets and six namespace-deleted errors in these cases all came
from previous Worker versions. The seven internal errors came from the new
Worker versions. These are observed categories, not a claim about Cloudflare's
internal cause of the opaque errors.

Follow-up reads in the new namespaces found **no started record** for those failed
operations. This reproduces the reset error after erase/redeploy, but does not prove
that an operation started in the new namespace and was reset there. The old caller
may still have targeted the retired namespace. It does not establish that old DOs
survived the erase.

## Final-file verification

[Run `7e1fce92`](evidence/2026-09-18-7e1fce92.json) exercised the final file with
`ROLLOUT_ROUNDS=1`, from 10:09:53–10:11:36 UTC (about 104 seconds). Setup/cleanup
now lives in a disposable fixture below the test; the embedded Worker and
probing sequence are unchanged. Requests again started 0–2ms after deploy exit.

| Case              | Completed | Code-update reset | Internal error | Namespace deleted | Parked response | HTTP 404 |
| ----------------- | --------: | ----------------: | -------------: | ----------------: | --------------: | -------: |
| Ordinary redeploy |         4 |                 3 |              2 |                 0 |               0 |        3 |
| Retire/recreate   |         0 |                 1 |              3 |                 4 |               4 |        0 |

All three ordinary resets again left unfinished durable records from the old
`bootstrap` version, followed by a different boot ID on the new version. Two
were called by the new Worker version. The control also reset with unfinished
work and a changed DO boot/version. Both fresh-case subtests failed, the control
passed, and the command exited 1. Cleanup succeeded despite the red assertions.

The 404 responses were Cloudflare's workers.dev “Page not found” HTML. They did
not enter the Worker/DO and are not counted as resets. One successful bootstrap
health check does not rule out hostname propagation still affecting other
requests to a newly provisioned Worker.

Across both runs: **8/48 ordinary-redeploy fresh operations hit explicit code-update
resets with unfinished durable work**. After retire/recreate, **6/48 first attempts
returned that reset error**, but without a started record in the new namespace.
These counts describe this sample; concurrent calls are not independent estimates
of the platform's general failure rate.

## Scope and checks

- Real Workers, native DO RPC, SQLite-backed DO storage, Node 26.0.0, Wrangler 4.107.0.
- No Iterate runtime, application data, deployment helpers, retry wrappers, or mocks.
- No live tail attached. Observability was enabled in the initial deploy. The final
  query captured 10 of the first run's 11 client-observed resets; log ingestion can
  lag, so the client responses and durable records are the primary evidence. A
  [later verification](evidence/2026-09-18-verification.json) captured all 11 and
  5 resets from the two runs, matching the client counts including controls.
- This is one client location and a small sample. It does not choose or justify
  a 30/60/90-second wait, or measure the last possible reset after deployment.
- Before the first cloud run, two local setup attempts failed before any deploy:
  relative `pnpm exec` PATH entries broke in the temp directory; the initial fix
  then shadowed `path.resolve` with the Promise resolver. Both were corrected.
- Wrangler dry-run compilation, standalone TypeScript checking, and targeted lint
  passed. Without the explicit opt-in, Node reports one manual-experiment skip.
- The two probe Workers are retained as inert parked Workers; their DO classes are
  retired. A separate API scan of all 302 account namespaces found none belonging
  to either probe; both public health endpoints returned `cleanup-parked`. The two
  failed setup attempts were also confirmed never to have created Workers. No
  production or existing preview Worker was modified. No PR was opened.

## Three independent tests — refactor verification

The file now declares three top-level `test(...)` cases. Each provisions its own
Worker, asserts its own outcome, and disposes its own deployment. There are no
nested tests or shared deployed state. Fresh-case assertions run after each batch;
a failed round ends that test, while the other tests still run. Earlier run tables
above describe the previous combined runner and remain unchanged.

Ran the refactored file with `ROLLOUT_ROUNDS=1` on 18 September, 12:02–12:04 UTC:

| Test                  | Evidence                                      | Result                                                                    |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Ordinary redeploy     | [594811da](evidence/2026-09-18-594811da.json) | Passed: all 12 operations completed.                                      |
| Retire/recreate       | [37254f99](evidence/2026-09-18-37254f99.json) | Failed: 9 parked responses, 2 internal errors, 1 completed operation.     |
| Active-object control | [389c028d](evidence/2026-09-18-389c028d.json) | Passed: code-update reset, unfinished durable work, changed boot/version. |

Node reported **3 tests, 2 passed, 1 failed**, with exit code 1 in 139 seconds.
The control ran after the failed retirement test, confirming their independence.
All three evidence files show cleanup removed the DO binding and the public
endpoint returned `cleanup-parked`. The embedded Worker source is unchanged.
TypeScript, targeted lint, formatting, and the non-cloud name-filter check passed.
Without the opt-in, the runner reports three explicit skips.
