---
status: done-with-findings
size: small
---

# Park damaged preview slots for Cloudflare debugging (rebuild disproven)

## Status summary

Complete, with a major finding that changed the plan mid-flight: **delete +
recreate does NOT fix a damaged slot — Cloudflare keys the broken state on
the worker NAME and it survives script deletion.** So instead of rebuilding
three slots, all six damaged slots are parked out of rotation under 30-day
debug leases. The pool now has 9 healthy available slots; nothing damaged
can be leased by a PR run until Oct 1.

## Background

The 2026-09-01 Cloudflare Artifacts incident (memory note
`preview-artifacts-403-config-repo`,
`explainers.ignoreme/cloudflare-artifacts-403-2026-09-01.html`) left slots
2/6/10/12/16 fully dead (all authed Artifacts git requests 403) and slot 3
half-broken (new-repo git ops 403 → project creation fails). Damaged workers
are evidence for the Cloudflare escalation but poison CI rotation.

## Checklist

- [x] Park preview_12, preview_6, preview_3 under 30-day
      `cf-artifacts-debug-20260901` leases _(leases e96bebc5 / 7ca57206 /
      c559b6ec, expiring 2026-10-01; preview_6 required force-evicting
      pr-2563's lease — worthless to them, the slot was dead)_
- [x] Rebuild preview_2: acquire → delete `os-preview-2` worker → redeploy
      from main → erase-data → redeploy os+auth → creation probe
      _(executed in full; the probe FAILED — see findings)_
- [x] ~~Rebuild preview_10, preview_16~~ _(skipped: preview_2 proved
      rebuilds don't work; churning two more slots would burn evidence for
      no benefit)_
- [x] Park preview_2, preview_10, preview_16 too _(leases 133887c3 /
      9cff119c / 40ef0661, expiring 2026-10-01; preview_10 required
      force-evicting pr-2556)_
- [x] Verify pool state _(9 available, 8 leased = 6 debug-parked + 2 live
      PR leases; all damaged slots out of rotation)_
- [x] Update incident memory note + explainer with the delete+recreate
      answer

## Findings (the important part)

Deleting `os-preview-2` (poisoned script) and recreating it fresh from main
did NOT restore Artifacts git access: the brand-new script, first deploy,
wiped slot, still gets `Config repo creation failed: HTTP Error: 403
Forbidden` (3/3 attempts) — while at the same moment a differently-named
scratch worker with the identical binding on the same namespace creates and
reads repos with 200s. Conclusion: **Cloudflare's per-worker rejection state
is keyed on the worker name (or something derived from it), persists across
script deletion, and cannot be cleared from our side by any means.** This
also strengthens the case that a fresh-named git-proxy sidecar would work as
an emergency workaround, and it is a significant new datum for the
Cloudflare escalation (their state store outlives the script lifecycle).

## Implementation log

- 18:18Z parked 12 (e96bebc5) and 3 (c559b6ec); 6 needed --force over
  pr-2563 (7ca57206).
- 18:20Z acquired slot 2 (bf9c8fba), deleted worker `os-preview-2` (API,
  force), redeployed from main — deploy green, smoke ok.
- erase-data preview_2 (DOs/D1/KV wiped), then redeploy os + auth (erase
  leaves the worker 503 and clears auth's OS client; order matters:
  erase → deploy, not deploy → erase).
- Creation probe: `itx.projects.get(...).create()` → 403, three times.
  Scratch-worker control probe at the same minute: 200.
- Released the rebuild lease, re-parked 2 under the debug holder
  (133887c3); parked 10 (9cff119c, forced over pr-2556) and 16 (40ef0661).
- `preview status`: 9 available / 8 leased.

## Unparking later

When Cloudflare confirms a fix: verify one parked slot (redeploy + creation
probe), then `pnpm preview release --slot N --lease-id <id> --force` (or
let the leases lapse Oct 1 — GC erases on reclaim). Lease ids above.
