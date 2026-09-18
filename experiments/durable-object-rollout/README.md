# Durable Object deployment reset probe

A manual, standalone Vitest e2e test against real Cloudflare. It embeds its entire Worker and Durable Object,
writes temporary Wrangler configs, and gives each of its four top-level tests
its own isolated Worker and disposable cleanup. Tests share no deployed state.
It imports only Vitest and Node builtins: no Iterate runtime, deployment helpers, auth service, or fixtures.

From the repo root (Node 26 and Wrangler 4.107.0 used for the recorded run):

```sh
ROLLOUT_ROUNDS=1 doppler run --project os --config preview_11 -- \
  pnpm test:e2e:do-rollout
```

To run just one test, use Vitest’s `-t` filter:

```sh
ROLLOUT_ROUNDS=1 doppler run --project os --config preview_11 -- \
  pnpm test:e2e:do-rollout -t 'ordinary redeploy'
```

The script sets `RUN_DO_ROLLOUT=1` and uses the dedicated `vitest.config.ts`.
Outside this repo, install Vitest, put `wrangler` on PATH and supply `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The test deliberately allows only our preview account;
change that assertion to use your own account. Without `RUN_DO_ROLLOUT=1` it reports
four explicit skips. This test is manual and is not part of CI or `pnpm test`.
To check discovery without deploying anything:

```sh
pnpm exec vitest run --config experiments/durable-object-rollout/vitest.config.ts
```

There are no test retries. Deploys and requests have their own deadlines, and reads
have a fixed attempt limit. The config disables Vitest’s overall test timeout so
its default five-second deadline cannot cut off deployment or disposable cleanup.

| Case                           | What happens                                                                                                           | What it can establish                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Ordinary redeploy              | Deploy changed code, then first-touch 12 unique DO names immediately after Wrangler exits                              | Whether fresh objects encounter deployment errors without namespace deletion |
| Retire/recreate                | Deploy the class as deleted, verify its binding is absent, redeploy the live class, then first-touch 12 unique names   | Whether new objects in a new namespace encounter deployment errors           |
| Retire/recreate with readiness | Recreate the class, poll until Worker and a separate DO report the exact new version, then first-touch 12 unique names | Whether one successful readiness probe predicts fresh-operation success      |
| Active-object control          | Start a 90-second operation, observe its durable started marker, then deploy changed code while it runs                | Whether the probe can capture a reset interrupting existing work             |

The three fresh-object tests each run up to three rounds, stopping at the first failed
round. `ROLLOUT_ROUNDS=1` through `10` changes that limit. A failed test does not
prevent the other tests from running. Fresh work lasts 15 seconds, repeatedly
writing progress to storage.
The immediate-use baselines wait for the initial, unmeasured Worker hostname to become
reachable, then perform measured deployments with **no health check or delay before writes**.
The readiness case instead polls a separate DO until one response identifies the
exact new version of both the Worker and DO, then immediately starts the 12 fresh
operations. It retains every readiness attempt and records the wait since Wrangler
exit. It also requires successful operations to have used that new version.

Run just the readiness experiment (three rounds by default):

```sh
doppler run --project os --config preview_11 -- \
  pnpm test:e2e:do-rollout -t 'Worker and DO readiness'
```

A passing readiness case is evidence for these sampled requests, not proof that
all subsequent requests or other client locations have converged.

Every operation runs once. Follow-up reads retry at most 30 times and keep every
response, including errors. Responses record the caller's Worker version separately
from the DO's version and per-constructor boot ID. The durable record retains the
identity that started the work even if a later constructor reads it.

A reset reproduction needs the actual error and unfinished work; a boot ID change
alone does not identify its cause. The control asserts the code-update error,
started-but-unfinished durable record, and changed DO boot/version. Fresh-object
tests assert that their single attempt and durable completion both succeeded.
A control-only reproduction does **not** reproduce an error affecting fresh objects.
A successful fresh-object run does **not** establish a safe deployment wait threshold.

Generated evidence stays local and is not committed. It is written to
`evidence.ignoreme/<run-id>/evidence.json` beside the test,
or `ROLLOUT_EVIDENCE_DIR/<run-id>/evidence.json` when set. Each test prints its own
evidence path, and the JSON identifies its scenario. It includes deployment command output, timestamps,
actual request age since Wrangler exit, namespace IDs, responses, follow-up reads,
and an after-run Workers Logs query for `code was updated`. No `wrangler tail` is
attached: enabling a tail can itself cause a DO software update. The log query is
supplementary; ingestion delay or query limits can omit events.

Cleanup retires the probe class and deploys an inert Worker. **It never deletes a
Worker** and never deploys to an existing Worker. A failed cleanup leaves the config
path in the evidence for recovery. Temporary configs contain a random probe access
token; the evidence redacts it. The token is removed from the parked deployment.

Cloudflare documents [eventual deployment propagation and tail-induced updates](https://developers.cloudflare.com/durable-objects/platform/known-issues/),
[DO shutdown and interrupted requests](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
and [class retirement deleting the namespace](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
This experiment tests a narrower question: what actually happens to these specific
operations immediately after the deploy command completes?

**Reproduced:** see [recorded results and the interrupted-operation timeline](RESULTS.md).
The live test exits nonzero when fresh operations fail; that is the result this
experiment is intended to expose, not a green CI check.
