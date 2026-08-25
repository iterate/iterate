---
status: ready
size: medium
---

# Config repo intent + worker error visibility

**Status summary**: spec complete (grill-you interview, 4 rounds — transcript
at [config-repo-intent-and-worker-error-visibility.interview.md](./config-repo-intent-and-worker-error-visibility.interview.md));
implementation not started.

Two platform gaps from the 2026-08-25 misha-project incident: a config repo
pinned a July SDK whose skew broke agent births twice over (missing `this.itx`
getter, then a moved `iterate/github-ai-linter` entry after the bump), and
both failures were near-invisible — one surfaced only inside the agent's own
chat, the other only in a subscription `lastError` field reachable over RPC.

## Gap 1 — template intent + re-sync button

- **No new intent storage.** The durable `createRequest` already reduced onto
  repo processor state IS the intent: `{type: "github-public-template",
  owner, repo, path, ref}` from the picker, or `{type: "empty"}` for
  programmatic creates seeded from the embedded `PROJECT_REPO_INITIAL_FILES`.
  `empty` maps to the same GitHub reference the picker's "Default" option
  sends, so every repo is syncable. A pinned-SHA `ref` (previews) is stripped
  when resolving "latest head" → default-branch HEAD.
- **`repo.syncFromTemplate()`** on the `Repo` itx capability. Per-file
  three-way against the template content at the last sync (initially the
  seed/root commit): user-unchanged → take latest template;
  user-edited-but-template-unchanged → keep user's; both-changed → **skip and
  report**. One normal default-branch commit, never a reset; no line-level
  merging (git history covers the curious). Appends
  `repo/template-synced {templateCommitOid}` as the next sync's base.
  Returns `{commitOid, updated, skipped, templateCommitOid, upToDate?}`;
  clear error on non-templated repos. GitHub-linked repos need nothing
  special — the commit mirrors like any other.
- **UI**: a "Template" row in the repo IDE chrome — "Created from
  `<owner/repo/path>` @ `<ref>`" + an "Update to latest template" button.
  Dumb button, no dry-run; the result toast lists updated/skipped counts and
  paths (with a line noting skipped = files you edited).

## Gap 2 — worker error visibility

- **Build failures: push, durable.** When the build coordinator records a
  terminal build failure for the config repo head, append
  `project/worker-build-failed {commitOid, error}` to `/` (failure
  counterpart of the existing `project/worker-updated`).
  `ProjectWorkerHealthWarning` renders it red until a later `worker-updated`
  supersedes it, and cross-links to the config repo IDE page (where the sync
  button lives — the incident's fix path was literally "worker broken →
  update template").
- **Child-stream subscription health: pull.** A named project-level itx
  capability method doing server-side fan-out over recently-active agent
  streams + well-known platform streams, returning per-stream subscription
  entries (name, status, lag, confirmedOffset, lastError, lastErrorAt).
  Dashboard polls it via react-query only while open (~60s). The method IS
  the programmatic surface for agents. Name/placement: implementer's call.
- **Severity tiers**: halted → red badge; lagging/backoff (delivery not
  currently flowing) → amber badge; historical `lastError` with zero lag →
  returned in the result and shown as a quiet informational line in the
  sheet, never the badge (alarm fatigue kills the surface).
- **`lastErrorAt`** recorded next to `lastError` at write time — no
  migration; absent = unknown age.
- Userspace reaction crashes stay surfaced via agent chat + the pull view's
  persisted `lastError`; no new surface for them.

## Guesses and assumptions (from the interview — spot-check these)

- `{type: "empty"}` → default-template mapping [guess: the embedded seed IS
  the default template at some ref; "same applies for other templates"
  implies universal coverage].
- "Recently-active agents + well-known platform streams" as the fan-out
  bound [guess: no cheaper activity signal exists].
- Health-warning → config-repo-IDE cross-link [guess: cheap, incident-shaped].
- `lastErrorAt` addition [guess: cheap now, unlocks time-aware tiers later].

## Residual risks (implementer: turn these into specs where possible)

- Seeds substitute `iterateRepoPkgRef`/`iterateRepoPkgSpecOverrides` into
  package.json; a GitHub-fetched sync must re-apply the same substitution
  (reuse the `projectRepoSeedFiles` repointing) before diffing, or every sync
  reports package.json as changed.
- Once an owner hand-edits package.json (as in the incident), template
  changes to it are skipped-and-reported forever — accepted; say so in the
  toast copy.
- Old repos with pre-substitution history may report a noisy first sync —
  harmless (normal commit); cover with an integration spec.
- The fan-out bound may need a tighter activity signal if agent streams
  accumulate fast.

## Out of scope

Auto/scheduled re-sync; pkg.pr.new staleness; SDK export-layout changes;
notifications beyond the dashboard; the 7.5-minute processor-stall incident;
retrofitting intent onto repos beyond the `empty`→default mapping.

## Checklist

- [ ] `repo.syncFromTemplate()`: template resolution (github-public-template
      + empty→default), three-way file plan, skip-and-report, normal commit,
      `repo/template-synced` event, package.json substitution re-applied
- [ ] integration specs: clean sync, user-edited-keep, both-changed-skip,
      repeated sync no-op (`upToDate`), first-sync-on-old-history
- [ ] repo IDE "Template" row + button + result toast
- [ ] `project/worker-build-failed` appended on terminal build failure;
      ProjectWorkerHealthWarning renders + supersession + cross-link; spec
- [ ] subscription-health itx method (fan-out, tiers, lastErrorAt) + spec
- [ ] dashboard sheet: red/amber badges, informational lastError rows,
      react-query polling gated on visibility
- [ ] docs breadcrumb (apps/os/AGENTS.md or docs/) for both surfaces

## Implementation log

(append as you go)
