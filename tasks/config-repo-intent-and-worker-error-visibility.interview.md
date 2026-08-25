# Interview log — config-repo-intent-and-worker-error-visibility

## Q1 — merge semantics of the template re-sync button — 2026-08-25
Interviewer found intent already stored (`createRequest` in repo processor state: github-public-template {owner,repo,path,ref} or empty→embedded seed). Q: merge semantics when user edits collide? Recommends per-file three-way, both-changed files skipped and reported, one normal commit, `repo/template-synced {templateCommitOid}` records the next base.

## A1
Per-file three-way as recommended: unchanged→take template, user-edited-only→keep, both-changed→skip and report in the button's result. One normal commit, never reset. Record the sync point event. No line-level merging ever — git history covers the curious. For `{type: "empty"}` createRequest repos: treat them as "default template" for sync purposes — map to the same GitHub reference the picker's Default option uses, so the button works everywhere [guess: Misha said "same applies for other templates", implying the default path must work too, and the embedded seed IS the default template at some ref].

---
## Q2 — mechanism for surfacing build failures + child-stream sub trouble — 2026-08-25
Findings: child-stream project-worker subs use onFailingEvent:"skip", build failure = receiver-unavailable backoff with lastError (no durable halt); worker-build-coordinator DO already records terminal build failures; project/worker-updated has no failure counterpart; per-stream fan-out wakes DOs. Recommends: (1) push durable `project/worker-build-failed {commitOid, error}` to `/` on terminal build failure, extend ProjectWorkerHealthWarning, superseded by later worker-updated; (2) pull for child-stream sub health via project-level itx method fanning out server-side, react-query polled while dashboard open, bounded to recently-active streams.

## A2
Yes to both halves exactly as recommended. The pull method doubles as the programmatic surface the dossier wants, so name it as a proper itx capability (something like `itx.project.workerHealth()` or on streams — implementer's call). Bounding: recently-active agents + well-known platform streams is right [guess: no better activity signal exists cheaply]. Note the pull surface also retroactively covers incident 1's shape (the skip-after-3-attempts lastError persists on the agent stream), which is why I'm fine leaving userspace reaction crashes otherwise where they are.

---
## Q3 — product surface: itx method + button placement — 2026-08-25
Recommends `repo.syncFromTemplate()` on the Repo itx capability (github-public-template or empty→default; clear error otherwise), returning {commitOid, updated, skipped, templateCommitOid, upToDate?}; button in the repo IDE chrome as a "Template" row ("Created from X @ ref" + "Update to latest template"); GitHub-linked repos need nothing special.

## A3
Yes to all of it. One sweetener: when the health sidebar is showing a worker BUILD failure (gap 2), link from that warning to the config repo's IDE page where the sync button lives — the incident's fix path was exactly "your worker is broken → consider updating your template" [guess: cheap cross-link, high incident-shaped value]. Keep the button dumb: no preview/dry-run this pass; the result toast lists updated/skipped.

---
## Q4 — severity tiers: does stale lastError alarm? — 2026-08-25
lastError persists with no timestamp; skip-policy means old blips carry lastError forever with zero lag. Recommends three tiers: halted=red, lagging/backoff=amber, historical-lastError-only=informational (in method result + quiet sheet line, no badge).

## A4
Agreed on all three tiers and the no-badge rule for historical errors — alarm fatigue kills the surface. One small addition: start recording `lastErrorAt` next to lastError at write time (tiny stream-layer touch, not a migration — absent on old records is fine) so the tiers can become time-aware later and the sheet can show "3d ago" [guess: cheap now, unlocks better policy later; display treats missing timestamp as "unknown age"].

---
## Wrap — decision summary — 2026-08-25
Interviewer declared the tree covered after Q4 and produced the decision summary + residual risks (reproduced in the task file). ready for Phase 2.
