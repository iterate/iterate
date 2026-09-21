status: in-progress
size: small

# First-message Jev documentation experiment

Fresh implementation from main. The first branch is a reference only; this version
will use the existing birth debounce and project-worker events, with no core changes.

## Request and decisions

- Base: `origin/main` at `a5937744d9`; branch `experiment/jev-first-message`.
- On agent creation, lower the existing 60-second birth debounce to one second.
- For the first incoming message only, select Iterate API docs/examples with
  Cloudflare `typesafe/jev`; inject timely results as ordinary context.
- Restore the ordinary 250ms debounce on success, failure or deadline. Later
  messages never wait for or rerun Jev. Ignore late results.
- Best effort: the first answering request can proceed without docs after one
  second. Include delivery/search/fetch overhead in that deadline where possible.
- Record selection status, sources and timing in project-owned stream events.
- Keep the earlier branch intact. Commit/push this worktree, no PR. Each commit
  carries the proposed review body. Deploy and prove the new implementation on a
  leased preview; do not rely on the earlier branch's core hook being present.

## Checklist

- [x] Create a fresh worktree and commit the specification. *Separate branch from current main; earlier implementation remains available for comparison.*
- [ ] Write a failing behavioral test using the real agent processor and template.
- [ ] Implement first-message-only selection entirely in userland.
- [ ] Prove timely context, timeout/error fallback, late-result discard and 250ms later turns.
- [ ] Run typechecks/lint and live e2e on a preview without core changes.
- [ ] Record evidence, complete task, commit and push; return compare and demo links.

## References

- Earlier experiment: `experiment/jev-doc-context` (no commits imported).
- Model API: https://developers.cloudflare.com/ai/models/typesafe/jev/
- Existing birth configuration: `configs/default/worker.ts`.
- Codex session: `01a0c535-0786-7a02-bc8e-6db66b7fb41a`.

## Implementation log

2026-09-21: User narrowed selection to the first message, explicitly permitting a
one-second best-effort budget and restoring 250ms for later requests. This removes
the requirement that led the earlier experiment to add a core callback.
