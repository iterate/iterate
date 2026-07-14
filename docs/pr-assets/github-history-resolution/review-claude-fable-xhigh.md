# Review: PR #1994 — GitHub link UI (pull-first connect, history resolution, installation picker)

I read the full branch diff vs origin/main plus the backend surfaces it depends on (`repo-durable-object.ts`, `github-link.ts`, `rpc-targets.ts`, routes, `itx-react.tsx`). Note: the uncommitted fixes were committed mid-review as `3cf14d586` — I reviewed that state. **Both known Bugbot findings are correctly fixed** (lowercase stamp verified against `CanonicalStreamPath`'s regex in `stream-links.ts:9`; `(recommended)` now tracks `defaultChoice`). Unit tests pass (6/6). The core lifecycle design — resolution state lifted to the parent so the live `state.github` flip doesn't unmount the conflict step — is sound, and it works even though `LinkForm` unmounts mid-mutation, because the callbacks are `useMutation`-options-level (they fire from the mutation cache, not the observer). The link-time conflict detection also correctly covers the "GitHub never saw this head" case: compare-404 maps to `"unrelated"` (`repo-durable-object.ts:1168`), which the matcher catches.

No blockers. Findings:

## Major

**1. `LinkForm`'s connections query shares a query key with `AddRepoFromGithub` but has opposite error semantics — and a failure blanks the whole IDE.**
`repo-github-panel.tsx:279-289` uses key `["github-connections", projectId]` with a queryFn that _throws_; `add-repo-from-github.tsx:48-66` uses the _identical key_ with a queryFn that catches and returns `[]` (with a comment explaining exactly why: a suspense-query throw takes down the whole page). Two consequences: (a) a transient `integrations.list()` failure in the sidebar propagates past the local `<Suspense>` (repo-ide.tsx:483 — Suspense catches suspension, not errors) to the route's `ItxBoundary` and blanks the entire IDE; (b) whichever component fetches first poisons the other — if the wizard's swallowed-error `[]` is cached, the panel renders "connect a GitHub account on the integrations page" when the truth is "listing failed". Extract one guarded `listGithubConnections` into `github-installation-repos.ts` next to the picker (this PR already did that extraction for the repo list — finish the job).

**2. Interactive `LinkedPanel` window while the pull-first sync is still running.**
The link mutation does `linkGithub` → `syncFromGithub` (`repo-github-panel.tsx:295-337`). The moment `linkGithub` resolves, live state flips `state.github` non-null and the panel swaps to `LinkedPanel` — while the sync (an in-process history transfer that can take many seconds on real repos) is still in flight. In that window: the panel shows "Last mirror push: **failed** … non-fast-forward" in red (the _expected_ initial-push outcome for a pre-existing GitHub repo, per `github-link.ts:232-241`, presented as an error); all three buttons are enabled, so the user can fire a concurrent Sync (racing a second conflict prompt), Push, or — worst — **Unlink**, after which the pending sync's conflict step appears for a link that no longer exists and every resolve choice fails confusingly. The DO serializes writes so nothing corrupts, but the UI lies. Fix: lift the link mutation to `RepoGithubPanel` (where `resolve` already lives) and render a "Linking — pulling from GitHub…" state until the mutation settles, or gate `LinkedPanel`'s actions on it.

**3. The agent-merge prompt's suggested recipe cannot complete as written.**
`github-history-resolution.ts:86-89`: step 4 says commit the merged tree with `commitFiles` then `pushToGithub()`, and the closing line forbids force-pushing to GitHub. But a `commitFiles` commit is an ordinary child of the _project_ head — GitHub's commits are not its ancestors, so the mirror push is **guaranteed non-fast-forward** (`repo-durable-object.ts:801`), and the only allowed exits are the force the prompt forbids or stalling to ask the user. The recipe that actually converges: merge in the sandbox, push the real merge commit (both parents) to GitHub `main` (octokit git-data API, or a git push with a minted token), then a plain `syncFromGithub()` — GitHub is now strictly "ahead" and it fast-forwards cleanly (the webhook import may even do it automatically). Bless that path in the prompt, or explicitly bless force-push-after-content-merge (content is preserved; only GitHub's commit linearity is rewritten).

**4. Force pull is the one-click recommended default with no blast-radius signal.** (UX/safety)
Unlike the wizard — which only ever force-syncs a fresh seed and has a taken-path gate specifically so `/repos/config` can't be silently clobbered (`add-repo-from-github.tsx:32-38`) — the panel links _existing_ repos with real history. The conflict step then pre-selects "Use GitHub's version" and the confirm button (default variant, not destructive) discards local-only commits in one click. Mitigations exist (explicit option text; discarded commits stay unreferenced in the Artifacts object store per `repo-durable-object.ts:830-833`), but there's no "this discards N local commits" signal even though the backend compare already knows ahead/behind. Minimum: `variant="destructive"` on the confirm button for pull/push. Better: surface ahead/behind counts in the step.

## Minor

**5. Conflict matcher is both redundant and loose** (`github-history-resolution.ts:9-22`): `"is not a fast-forward"` is subsumed by `"not a fast-forward"`; quoted `'"diverged"'`/`'"unrelated"'` are subsumed by the unquoted checks below them (only `'"behind"'` narrows anything). And unquoted `includes("unrelated")` on arbitrary error text is a false-positive risk — any transport/auth message containing that word flips the UI into the force-resolution flow. Match the two canonical backend messages tightly instead (`non-fast-forward`, `syncFromGithub is not a fast-forward`, plus the quoted `GitHub says "…"` statuses).

**6. `option.default` is now write-only.** After the Bugbot fix, every call site passes `preferred` explicitly; the only consumer of `default: true` is its own unit test (`github-history-resolution.test.ts:38`) — exactly the assert-metadata-nothing-consumes pattern this repo avoids. Delete the field and the test, or make it the genuine fallback.

**7. Dead/confused error fallback in `LinkForm`** (`repo-github-panel.tsx:331-336`): the inner `syncError instanceof Error ? syncError.message : …` is unreachable (already known false at that point), and since RPC errors are `Error`s in practice, the first branch always wins — `result.initialPush.error` is effectively never surfaced despite the comment promising "the better error".

**8. A failed repo listing caches as a _successful_ query** (errors-as-data, `github-installation-repos.ts:53-57`): TanStack won't retry it, and the sidebar copy says "try again" with no retry affordance (the dialog's old copy said "reopen this dialog", which at least described a real remount path). Consider a retry button that invalidates `["itx", "github-installation-repos", …]`.

**9. Picker filter persists across connection switches** in `LinkForm` — `selected` is reset (`repo-github-panel.tsx:407`) but `InstallationRepoPicker`'s internal `filter` isn't (no `key={connection}`), so switching connections can land on "No repositories match."

## Nits

- `githubHistoryMergeAgentPath` test re-derives the path regex instead of asserting `StreamPath.safeParse(path).success` against the real validator in `~/lib/stream-links.ts` — the actual consumer, and the stronger anchor.
- `docs/pull-requests.md` is solid; consider recommending the SHA-pinned raw URL as the default (branch URLs rot after post-merge branch deletion — the doc lists it but as the alternative).
- Stale-resolution-across-repo-switches is a non-issue — `RepoIde` is keyed `${project.id}:${repoPath}` in the route, so the panel remounts. Worth keeping that key.

## Missing tests

- **The link decision tree is the branchiest new logic in the PR and is untested.** Extract the `synced | conflict | pushed | rethrow` classification from `LinkForm`'s mutationFn into a pure helper (result + syncError in, outcome out) and unit-test it — including the empty-GitHub-repo path (initial push ok + sync throws "missing branch") and the compare-404/"unrelated" link-time conflict.
- **No regression test for the contextual `preferred` mapping** (push failure → `"push"`, sync/link failure → `"pull"`) — that's Bugbot finding #2's exact bug class, and the fix is only exercised by eyeball.
- No UI coverage of the resolution step at all — `data-testid="github-history-resolution"` exists but nothing references it; `github-backed-repo.e2e.test.ts` covers backend verbs only.

## Top 3 actions

1. **Extract a shared, guarded `github-connections` query** into `github-installation-repos.ts` — fixes both the whole-IDE blanking and the same-key/different-queryFn cache collision (Major 1).
2. **Lift the link mutation into `RepoGithubPanel`** and show a "linking — pulling from GitHub" state until sync settles, so the mid-flight `LinkedPanel` (with its misleading red failed-push row and live Unlink button) never renders (Major 2).
3. **Fix the agent-merge prompt recipe** (merge → push merge commit to GitHub → plain fast-forward sync) and add the decision-tree + preferred-choice unit tests while touching that file (Major 3 + test gap).
