---
status: in-progress
size: small
---

# "Config worker stalled" — skip-mode parks after seconds of receiver-down

## Status summary

Diagnosed; prod remediated (subscription resumed by hand, caught up instantly).
Code fix in progress: stop terminal-parking skip-mode subscriptions after a
few seconds of receiver outage — route the "everything fails" case into the
shared backoff/park machine so it tolerates hours like park mode does.

## Incident

`os.iterate.com/projects/misha` showed the red "Config worker stalled" sidebar
warning. The root stream's `project-worker` subscription (the config worker
push feed) was parked at offset 70 with 792 events of lag.

Timeline (2026-07-22, UTC):

- 18:07:24 — delivery to the project worker starts failing with
  `Unable to deserialize cloned data due to invalid or unsupported version.`
  (workerd structured-clone version skew across the RPC boundary — transient
  Cloudflare fleet-rollout weather, not our payloads: offset 69 was a plain
  `stream/woken` fact)
- 18:07:28 — poison verdict on offset 69 after 3 attempts → skipped
- 18:07:31 — poison verdict on offset 70 after 3 attempts → skipped
- 18:07:34 — third consecutive poison verdict → `MAX_CONSECUTIVE_SKIPS` →
  **parked**. Ten seconds from first failure to giving up.
- 2026-07-23 — appended `subscription-resumed`; delivery caught up 70 → 866
  with zero failures. Receiver was fine; the outage lasted seconds.

## The flaw

`onPoison: "skip"` confirms a poison event after `SKIP_CONFIRM_ATTEMPTS` (3)
failures with ~1–2s backoffs, and parks after `MAX_CONSECUTIVE_SKIPS` (3)
consecutive verdicts. The consecutive-skip guard is right to refuse
mass-skipping a down receiver's backlog — but its response (terminal park,
human must click Resume) is wildly disproportionate to the evidence (~10s of
failures). Park-mode subscriptions tolerate `MAX_DELIVERY_ATTEMPTS` (15) with
exponential backoff — roughly 3.5 hours of continuous outage — before parking.
Skip mode should be at least as tolerant of a down receiver, since that is the
exact case the guard exists to detect.

Every project's config-worker feed uses `onPoison: "skip"`, so any ~10s
transient (Cloudflare rollout, worker redeploy hiccup) permanently stalls
config workers across the deployment until someone notices the red sidebar.

## Fix

- [ ] In `stream-subscribers.ts#onPushFailure`, when the consecutive-skip cap
      is reached, treat the receiver as DOWN: keep the cursor, do not skip, and
      fall into the shared `#onDeliveryFailure` backoff/park machine (attempt
      counter keeps growing past `SKIP_CONFIRM_ATTEMPTS`, exponential backoff
      up to the 30-minute cap, park only at `MAX_DELIVERY_ATTEMPTS`).
      While in this state the UI shows the amber "Config worker retrying"
      row instead of red "stalled".
- [ ] Update the `MAX_CONSECUTIVE_SKIPS` doc comment in `subscriber-math.ts`
      to describe the new behavior.
- [ ] Tests in `stream-subscribers.test.ts`: at the skip cap the subscription
      backs off instead of parking; recovery mid-backoff resets the streak and
      delivery resumes; sustained failure still parks at
      `MAX_DELIVERY_ATTEMPTS`.

## Out of scope (noted for later)

- The first two poison verdicts still each skip a healthy event during a short
  outage (~3s per verdict). Slowing poison confirmation (e.g. requiring the
  confirm attempts to span a minimum wall-clock window) would avoid that data
  loss but changes genuinely-poison latency; separate task if wanted.
- Auto-resume of parked subscriptions after a cooldown.
- Error classification (treating workerd serialization errors as
  receiver-unavailable) — brittle message-sniffing; the generic fix covers it.

## Implementation log

- 2026-07-23: prod `misha` remediated via `subscription-resumed` append
  (`doppler run --config prd -- pnpm cli itx run --context misha -e ...`).
  Caught up 70 → 866 immediately, zero failures, confirming transience.
