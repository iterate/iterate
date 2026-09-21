# Cycle preview leases through prepared slots

Status: implementing the real CI lifecycle. Existing measurements support parked-and-rested slots; the previous manual harness is not part of this branch.

Product-changing commits get a separate candidate slot while the current human preview remains usable. Publish the candidate only after readiness succeeds. Retire the previous slot in a separate CI job: erase/park, hold its lease through a bounded rest, then release with a preparation record. Prefer the oldest prepared available slot. Skip entry erase and the postdeploy 90s gate only with valid preparation; unknown slots use the normal guarded path. Retain post-test erase/restoration of the new preview and hours-long human leases. Docs inheritance and tests-only reuse do not rotate.

Use normal workflow inputs and shared service contracts, without branch-name flags or a manual preparation step. Preparation records must be consumed on acquisition and cannot survive intervening use. Recovery must not steal leases or destroy the currently published preview. Keep the old preview if acquisition, deployment or readiness fails. Pool exhaustion waits or fails visibly while preserving that preview.

- [x] Cover lease preparation, consumption and ownership transfer through the real Semaphore API. *HTTP/Workerd tests exercise tags and atomic expected-holder adoption.*
- [x] Implement candidate publication, safe failure handling and prepared-slot selection. *`ciPrepare` preserves the published report until readiness; acquisition validates consumed tags.*
- [x] Wire bounded retirement and cancellation recovery into CI and cleanup. *The separate retirement job collects non-current holds; interrupted rest earns no tags.*
- [ ] Preserve reuse, post-test restoration and exact settled-version evidence.
- [ ] Validate local behavior and actual PR CI across consecutive commits; retain raw evidence ignored.
- [ ] Address review feedback and document the resulting lifecycle.

Do not delete Workers: park and rest, retaining container applications and asset caches. The earlier deletion arm added cost and had a recreation failure. Keep the default 90s guard when preparation is absent or uncertain. No merge is authorized.

Session: Codex 01a0b054-bdd8-7d52-9c01-30d9b92576c8.
