---
state: backlog
priority: medium
size: small
---

# Make preview observations deterministic

Owner: OS runtime and mobile maintainers. Revisit by 2026-09-22.

PR #2599 does not change mobile chat/notes or facet lifecycle code. Its preview
runs exposed these unrelated test problems while validating document review.

## Facet source-version observation

`apps/os/e2e/vitest/userspace-facet-source-version.e2e.test.ts` cannot distinguish
commit-triggered rebuilds from unrelated recycling, even across three rounds.
The underlying limitation is already tracked in `tasks/platform-stall-repros.md`
(thread 5), with a companion forced-recycle reproduction.

Evidence from Depot org `0p91s0lz49`:

- Run `9184gpn9n2`, attempt `kk45h33gvr`, head `0271e5812`: the body passed in
  92.6s, making the strict `SAME-BOOT STALENESS` pin unexpectedly red.
- Its unchanged-commit rerun, attempt `7wllws629m`, passed the integration suite
  with the expected staleness observation.
- Run `jbjdctf2ck`, attempt `lf340f6k0c`, head `c2e2fff65`: the body passed in
  75.4s, again making the strict pin red. All 58 other integration files passed.

The test now uses `createFlake` for exactly `/SAME-BOOT STALENESS/`: both success
and this known failure remain measured on every run. Different errors and hangs
stay red. The body and its 230s watchdog are unchanged; no test is skipped.
This does not declare the runtime bug fixed.

Exit criteria: record rebuild provenance so this observation can distinguish an
actual source-triggered replacement from recycling; then restore a strict pin
if the defect persists, or an ordinary passing test once fixed. Inspect the
measured outcomes before changing the wrapper.

## Mobile note-to-chat navigation

`specs/mobile/notes.spec.ts` failed at `inputValue()` after “Chat about this note”
in both attempts of `9184gpn9n2` and `jbjdctf2ck`. The captured page already shows
the correct prefilled Message textbox. `inputValue()` bypasses the navigation
and spinner middleware used by `waitFor()`.

The spec now waits for the textbox through that middleware before reading its
value. No action timeout was increased and no flake wrapper was added. The live
preview must validate the complete capture/edit/chat/send/delete flow.
