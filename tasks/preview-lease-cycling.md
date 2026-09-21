# Cycle preview leases through prepared slots

Status: real CI cycling implemented and observed across two commits. Prepared-slot shared readiness fell from 118.2s to 38.5s. Full-suite validation is still in progress; test failures and a coordination retry invalidated the first runs.

Product-changing commits get a separate candidate slot while the current human preview remains usable. Publish the candidate only after readiness succeeds. Retire the previous slot in a separate CI job: erase/park, hold its lease through a bounded rest, then release with a preparation record. Prefer the oldest prepared available slot. Skip entry erase and the postdeploy 90s gate only with valid preparation; unknown slots use the normal guarded path. Retain post-test erase/restoration of the new preview and hours-long human leases. Docs inheritance and tests-only reuse do not rotate.

Use normal workflow inputs and shared service contracts, without branch-name flags or a manual preparation step. Preparation records must be consumed on acquisition and cannot survive intervening use. Recovery must not steal leases or destroy the currently published preview. Keep the old preview if acquisition, deployment or readiness fails. Pool exhaustion waits or fails visibly while preserving that preview.

- [x] Cover lease preparation, consumption and ownership transfer through the real Semaphore API. *HTTP/Workerd tests exercise tags and atomic expected-holder adoption.*
- [x] Implement candidate publication, safe failure handling and prepared-slot selection. *`ciPrepare` preserves the published report until readiness; acquisition validates consumed tags.*
- [x] Wire bounded retirement and cancellation recovery into CI and cleanup. *The separate retirement job collects non-current holds; interrupted rest earns no tags.*
- [x] Preserve reuse, post-test restoration and exact settled-version evidence. *The first cycling run restored preview-15; publication and exact versions are recorded in the managed PR report.*
- [ ] Validate local behavior and actual PR CI across consecutive commits; retain raw evidence ignored.
- [ ] Address review feedback and document the resulting lifecycle.

Do not delete Workers: park and rest, retaining container applications and asset caches. The earlier deletion arm added cost and had a recreation failure. Keep the default 90s guard when preparation is absent or uncertain. No merge is authorized.

Session: Codex 01a0b054-bdd8-7d52-9c01-30d9b92576c8.

Implementation notes: PR #2751 contains only the implementation, regression tests, docs and this task. Raw runs and logs remain under `evidence.ignoreme/preview-lease-cycling/`. Bugbot found local-command lease retention and queue regressions; both have fixes. A fresh workflow is needed after any failed runner; partial retries deliberately invalidate coordination.
