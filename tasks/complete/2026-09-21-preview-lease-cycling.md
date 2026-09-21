# Cycle preview leases through prepared slots

Status: implemented and exercised in real CI. Prepared-slot smoke takes roughly 27–38s versus 117.5s with the guard. The follow-up cross-slot cleanup bugs are fixed with regressions; the replacement run passed all tests and restored the human preview. PR #2751 records current-head checks and repeat-run evidence; no merge is authorized.

Product-changing commits get a separate candidate slot while the current human preview remains usable. Publish the candidate only after readiness succeeds. Retire the previous slot in a separate CI job: erase/park, hold its lease through a bounded rest, then release with a preparation record. Prefer the oldest prepared available slot. Skip entry erase and the postdeploy 90s gate only with valid preparation; unknown slots use the normal guarded path. Retain post-test erase/restoration of the new preview and hours-long human leases. Docs inheritance and tests-only reuse do not rotate.

Use normal workflow inputs and shared service contracts, without branch-name flags or a manual preparation step. Preparation records must be consumed on acquisition and cannot survive intervening use. Recovery must not steal leases or destroy the currently published preview. Keep the old preview if acquisition, deployment or readiness fails. Pool exhaustion waits or fails visibly while preserving that preview.

- [x] Cover lease preparation, consumption and ownership transfer through the real Semaphore API. *HTTP/Workerd tests exercise tags and atomic expected-holder adoption.*
- [x] Implement candidate publication, safe failure handling and prepared-slot selection. *`ciPrepare` preserves the published report until readiness; acquisition validates consumed tags.*
- [x] Wire bounded retirement and cancellation recovery into CI and cleanup. *The separate retirement job collects non-current holds; interrupted rest earns no tags.*
- [x] Preserve reuse, post-test restoration and exact settled-version evidence. *The first cycling run restored preview-15; publication and exact versions are recorded in the managed PR report.*
- [x] Validate local behavior and actual PR CI across consecutive commits; retain raw evidence ignored. *473 scripts tests and eight Semaphore tests pass; run `crf8f1vt30` passed all app suites and six browser shards, then restored the preview.*
- [x] Address review feedback and document the resulting lifecycle. *Both Bugbot findings fixed and resolved; deployment docs and the PR describe recovery, rollout dependency and remaining reliability caveats.*

Do not delete Workers: park and rest, retaining container applications and asset caches. The earlier deletion arm added cost and had a recreation failure. Keep the default 90s guard when preparation is absent or uncertain. No merge is authorized.

Session: Codex 01a0b054-bdd8-7d52-9c01-30d9b92576c8.

Implementation notes: PR #2751 contains only the implementation, regression tests, docs and this task. Raw runs and logs remain under `evidence.ignoreme/preview-lease-cycling/`. Bugbot found local-command lease retention and queue regressions; both have fixes. A fresh workflow is needed after any failed runner; partial retries deliberately invalidate coordination.

Final evidence: automatic preview-2/preview-15 rotations consumed preparation tags, preserved the published URL until readiness and released old slots only after rest. The final code commit is `f8d54c866`; its workflow `69qzddcfx8` published `tests=success; deployment=restored`. Retirement is excluded from test-verdict and trace completion checks. No experiment harness or generated evidence is tracked.

Follow-up 2026-09-21: workflow `5q00bpl0dc` failed four sandbox app tests and browser shard 3, then restoration. PR #2755's preview-5 preparation (`grdgpkb25c` / `j0xkm31jsz`) logged deleting all six preview-2 container applications as “dangling”; the exact reason its namespace inventory omitted them is not proven. Workers logs then reported no application assigned. Erasure used application presence to decide what to preserve and deleted all six classes. Removed the account-wide sweep and switched erasure to the declared class set. Added exports bootstrap recovery supported by the current raw API; all six preview-2 namespaces now report `use_containers=true`. Worker/routes retained. 477 scripts tests, types and focused lint pass. Replacement workflow `1z42cg5jjh` passed all app suites, all six browser shards, retirement and restoration (`tests=success; deployment=restored`), with 33.3s agent smoke. Review also prompted preserving live Worker exports omitted by namespace inventory, covered by a failing-then-passing regression. The PR records the next return to repaired preview-2.
