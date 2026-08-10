---
status: in-progress
size: small
---

# PostHog CI telemetry delivery is queryable

Status: Root cause fixed: normal finalizers now deliver by default instead of silently waiting for a nonexistent Doppler opt-in. Focused checks pass; a canonical stacked preview still needs to prove natural PostHog visibility.

- [x] Classify the missing telemetry without treating retained artifacts as delivery proof. *Multiple complete preview artifacts contained the restored specs and finalizer, but their workflow IDs had no natural PostHog rows.*
- [x] Prove the canonical target and Depot network path independently. *Local and Depot probes used the same `_shared/prd` host and token fingerprint; matched one-event and 100-event batches became queryable from both sources.*
- [x] Find the silent production branch. *`finalizeTestTelemetry` required `CI_TELEMETRY_POSTHOG_ENABLED === "1"`, but `_shared/prd` has no such secret. The tests supplied it in `beforeEach`, masking production.*
- [x] Make delivery the default and keep one explicit no-send path. *Normal test finalizers and scheduled source syncs always call `sendPostHogEvents`; `--dry-run` remains the documented opt-out and cancellation still retains without sending.*
- [x] Prove the default-delivery contract without ambient test state. *The delivery assertion failed with zero calls before the fix and passes after it; the hidden env hook and suite hooks are gone.*
- [x] ~~Change PostHog batching, pacing, migration mode, or routing identities.~~ *Rejected as false leads once the missing call gate was found; follow-up commits restore the existing 5 MB batching and stable event model.*
- [x] Replay retained clean preview evidence idempotently. *Three natural retry-zero restored-spec pairs and complete finalizers are queryable without duplicate facts.*
- [x] Run focused tests, typecheck, lint, format, and diff checks. *Focused checks pass; exact totals are recorded with the final proof run.*
- [ ] Run a canonical stacked preview and prove its natural upload is queryable without replay.

## Implementation notes

- `normalized ... event(s)` was the final log line because the opt-in check skipped `sendPostHogEvents`; there were no accepted natural CI requests to tune.
- The matched probes ruled out project-token drift, Depot egress, the 100-event request size, and the representative rich event shape.
- The historical-migration experiment was also invalid for current evidence: PostHog requires historical timestamps to be at least 48 hours old.
- The original deterministic UUIDs, stable `distinct_id` model, 5 MB request budget, and explicit three-attempt delivery failure path remain intact.
- This work is stacked on `fix/preview-fixed-otp-rate-limit`, which is stacked on `fix/egress-approval-settlement-retry`, so its canonical preview can exercise the complete restoration path.
