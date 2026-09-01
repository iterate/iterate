---
status: in-progress
size: small
---

# Park 3 damaged preview slots for Cloudflare debugging, rebuild the rest

## Status summary

Spec committed; implementation is operational (CLI/API runs logged below) —
no product code changes expected. Not started yet beyond the spec.

## Background

The 2026-09-01 Cloudflare Artifacts incident (see memory note
`preview-artifacts-403-config-repo` and
`explainers.ignoreme/cloudflare-artifacts-403-2026-09-01.html`) left preview
slot workers in three states:

- **Fully dead** (redeployed during the poisoning window): os-preview-2, -6,
  -10, -12, -16 — every authenticated Artifacts git request 403s, forever.
  Nothing except deleting and recreating the worker script (fresh identity)
  can plausibly fix them, and only Cloudflare can repair the state in place.
- **Half-broken** (redeployed after the window): os-preview-3 — existing
  repos read/write fine, brand-new repos 403, so project creation fails.
- **Healthy**: everything not redeployed since Aug 31.

Damaged workers are valuable evidence for the Cloudflare escalation, but
useless (and harmful — red e2e) in the CI rotation.

## Decisions (assumptions made while Misha is elsewhere)

- **Park for Cloudflare debugging** (out of rotation, left broken):
  **preview_12** (fully dead; its ray IDs are cited in the evidence pack),
  **preview_6** (fully dead; second sample), **preview_3** (half-broken; the
  diagnostically interesting contrast). Mechanism: a 30-day specific-slot
  lease — `pnpm preview acquire --slot N --as cf-artifacts-debug-20260901
  --hours 720` (720h = semaphore MAX_LEASE_MS). PR runs only lease free
  slots and GC only reclaims expired leases, so a held lease IS
  out-of-rotation. Renew or release when Cloudflare is done.
- **Destroy and rebuild**: **preview_2, preview_10, preview_16**. "Destroy"
  means deleting the `os-preview-N` worker script itself — the poisoned
  script identity and its Durable Object data (disposable by design; slots
  are erased on every acquire anyway). Sidecars (`-typechecker`,
  `-worker-bundler`) and `auth-preview-N` are NOT deleted: no artifacts
  bindings, not poisoned, and deleting them buys nothing.
- Rebuild deploys use current `main`.

## Checklist

- [ ] Park preview_12, preview_6, preview_3 under 30-day
      `cf-artifacts-debug-20260901` leases (force-evict stale PR leases if
      any; the parked slots must show as leased in `pnpm preview status`)
- [ ] For each of preview_2, preview_10, preview_16:
  - [ ] acquire the slot (force if stale-leased)
  - [ ] delete the `os-preview-N` worker script via the Cloudflare API
        (explicitly authorized for these slots on 2026-09-01 — the repo's
        "workers are never deleted" rule is deliberately being excepted)
  - [ ] redeploy from main (`pnpm run deploy --env preview_N` in apps/os) —
        recreates the script with a fresh identity; routes are ensure-only
        so hostnames come back
  - [ ] erase leftover slot state (`erase-data` / stale project-directory KV
        keys) so old DO-era references don't confuse the fresh worker
  - [ ] verify: `itx projects.get(<slug>).create()` succeeds end-to-end
        (this is the operation the poisoning breaks — it doubles as the
        proof that fresh script identities still provision cleanly)
  - [ ] release the lease back to the pool
- [ ] Update the incident memory note + explainer with the outcome
      (especially whether delete+recreate un-poisons — it's the one lever we
      never tested)

## Risks / notes

- If the poisoning window reopens mid-rebuild, the freshly recreated worker
  could be born broken — the creation probe before releasing the lease
  catches that; leave the slot leased and stop if so.
- Worker deletion drops the slot's DO storage (all preview projects there).
  That is the intent; preview data is throwaway.
- If delete+recreate does NOT fix a slot (state keys on the worker NAME, not
  the internal script id), park that slot too and report — that result is
  itself important for the Cloudflare escalation.

## Implementation log

(appended during the run)
