# Preview retirement and restoration experiment

[PR #2695](https://github.com/iterate/iterate/pull/2695), 2026-09-17.

The experiment works: tests can finish green while the preview is retired and
restored. The successful run took 18.2s to retire test data and 45.1s to restore
the apps; its preview check became green 72s before the job finished. Deliberate
failure and cancellation probes changed an early green check back to non-green.
The separate repository Test check remains red because of an existing expired
parked-test review date, described below.

## Behavior

1. Wait for all test jobs to stop; validate and merge their results.
2. If they all passed, mark this exact Depot-owned GitHub check successful.
3. Run the existing reset, retiring ordinary DO namespaces and parking Workers.
4. Redeploy Auth, OS and Streams from the tested checkout into the same slot.
5. Keep the lifecycle lock until the job really finishes. Depot records any
   later failure or cancellation on the same check.

Auth is included because reset wipes its OAuth client records. Ordinary deploy
commands restore code, secrets, assets, sidecars, bindings and application setup;
there is no second raw Worker upload implementation. Restoring code does not
restore the deleted namespace data or its alarms.

Pre-deploy reset, PR-close and expired-slot cleanup keep their existing behavior.
The reset still retains container classes because their deletion/recreation has
an upstream limitation. Restoration does not roll out new container images.

## Successful full run

Tested commit: `151dc2f9307871a3df1fb398296838449ab5950b`.
[Depot workflow](https://depot.dev/orgs/0p91s0lz49/workflows/lnhxm1vn0t) ·
[interactive trace](https://depot-01a0adfb-e30a-7d09-a4ab-cf0b59f4b126--iterate.iterate.app/).
All nine preview jobs passed: prepare, six browser shards, app tests and finish.

| Event                                                 | UTC          |
| ----------------------------------------------------- | ------------ |
| Preview workflow started                              | 06:02:11     |
| Last consumer finished                                | 06:07:35     |
| Results validated; check marked successful            | 06:07:46.779 |
| Independent read: GitHub success, Depot still running | 06:08:00.013 |
| Restoration started, after 18.2s reset                | 06:08:07.551 |
| Restoration completed                                 | 06:08:52.610 |
| Finish job completed successfully                     | 06:08:59     |

The `preview-os-test-artifacts` artifact contains `preview-restoration.json`,
recording the exact head, slot, times, and tested/restored Worker versions:

| App     | Tested version                         | Restored version                       |
| ------- | -------------------------------------- | -------------------------------------- |
| Auth    | `45dec431-be5d-4cec-956f-9d6bdcbccd6f` | `d4a4460c-c5a1-459d-8a12-35f35db3b2e8` |
| OS      | `96897df7-2814-48f5-a84d-abacc0272a83` | `899f9a2e-a565-4bb4-857d-ce5a610c1d60` |
| Streams | `0a979a44-a968-458b-8f37-af3e6b3f2216` | `449707dc-817a-4a75-a3e1-c4df0048581d` |

Direct Cloudflare readback before tests and after restoration showed all nine
ordinary OS namespaces and the Streams namespace replaced. All six Sandbox
namespaces stayed. The semaphore and dummy-petshop namespaces were outside the
reset scope and unchanged. Both full runs showed this same transition.

## Failure, cancellation and usability

Resource-free probes used the real Depot job token with `checks: write`. They
updated the check identified by the exact workflow/job URL, then deliberately
stopped during the observation window.

| Probe                                                                | Early GitHub state   | Concurrent Depot state                   | Final GitHub state     |
| -------------------------------------------------------------------- | -------------------- | ---------------------------------------- | ---------------------- |
| [Failure](https://github.com/iterate/iterate/runs/105090329542)      | success at 05:41:59Z | running, independently read at 05:42:57Z | failure at 05:43:00Z   |
| [Cancellation](https://github.com/iterate/iterate/runs/105090616821) | success at 05:44:26Z | running                                  | cancelled at 05:46:19Z |

A same-named commit status would be a separate result. Updating the Check Run
works because the token belongs to the Depot GitHub App that created it. Depot
preserves our explanatory output when updating the final conclusion, so the
text describes both phases rather than claiming cleanup is still running.

The [first full run](https://depot.dev/orgs/0p91s0lz49/workflows/xg4ww10ws2),
on `827ee33e98a50dbc5c64fd8b0da725a4e180b57f`, had a real test failure.
All six browser shards and all 218 OS e2e tests passed, but a Streams assertion
failed twice. Early green was correctly skipped. Retirement still completed in
17.0s and restoration in 56.6s.
[Its trace](https://depot-01a0adf1-644b-7f3d-837f-d7d42f6ed625--iterate.iterate.app/)
retains that failed-test/successful-restoration outcome.

Against its restored OS version `eaf2a638-8767-4587-9495-86a1f63c479e`, a smoke
created project `restore-smoke-988dc112`, ran a one-shot schedule, and read the
script's stream event in 16.3s. Real Auth sign-in followed the OAuth redirects
to OS `/projects/pr2695` with a valid session. These probes used the restored
deployment without an override pointing back at the earlier tested version.

A bounded local failure probe dirtied only this task's markdown file. Retirement
completed in 27.7s before restoration rejected the dirty checkout. Both OS and
Streams were verified at HTTP 503. Restoring the file byte-for-byte and rerunning
succeeded in 108.9s, including another reset. That cycle also retired the extra
probe project and stream. No failure switch is shipped in product code.

The Streams test had assumed its last callback batch was the event it just
awaited; a background feed projection could arrive afterwards. The small fix
asserts delivery of the exact event by offset and still checks closed-client
exclusion. Both a focused authenticated live test and the second full run passed.

## Activity evidence and its limits

For the first run's namespace IDs, Cloudflare analytics showed 1,309 Streams
invocations and 95 Sandbox invocations during 05:50–05:55Z, plus 243 periodic
records. The 05:56–05:58Z window after restoration returned no records, including
a repeat read at 06:10:20Z to allow reporting delay.

The ordinary OS namespaces had no visible positive control in these analytics:
empty results for them are not proof of inactivity. Their retirement is established
by the namespace/binding readback. The retained containers' quiet window is a
bounded observation, not a guarantee for every workload or instance type.

## Validation and remaining risks

- Scripts: 360 tests passed, including lifecycle order, result identity and
  authoritative lease targeting. Typecheck, lint, knip and formatting passed.
  All packages other than the lint package passed their tests independently.
- The repository Test check fails because `specs/repo-ide-jsonc.spec.ts` has a
  parked-test review date of 2026-09-16. It reproduces independently of this
  change. This experiment neither hides nor extends it.
- Independent review corrected two safety bugs: restoration checks must follow
  retirement, and deployment config must come from the semaphore lease rather
  than editable PR state. Refused restoration now also publishes a parked notice.
- External completion of Depot's check is observed behavior, not a documented
  provider promise. No repository protection settings changed. GitHub can allow
  a merge during cleanup, and that commit can turn red afterwards.
- Failed restoration may leave a parked or partly restored preview. Test results
  describe the earlier deployment; the receipt and PR notice distinguish the
  new versions. The original test suite is not rerun after restoration.
- Cancellation turns the check non-green but cannot guarantee interrupted cleanup
  finishes. Existing slot reclamation and reset-on-acquire remain necessary.
- Retained container namespaces still need the existing cleanup strategy; this
  experiment does not solve their retirement limitation.
