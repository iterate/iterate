# Preview work from the head commit

Read [`planPreview`](../scripts/preview/change-plan.ts) for the algorithm and
[`change-types.yml`](../scripts/preview/change-types.yml) for its ordered rules.
Each path gets the **last matching type**. Docs need nothing, Tests need tests,
and every other type needs deployment plus tests. Mixed changes take the union.

This classifies the head commit, not the whole PR. A docs-only head skips even
if earlier commits on that PR changed product code. All `.md` files currently
count as Docs, including ones inside apps; this is the requested initial policy,
not dependency analysis.

For a tests-only head, lookup precedes classification at each candidate:

```text
HEAD: tests → docs → deployed product commit    reuse that deployment
HEAD: tests → undeployed product commit → …     deploy HEAD; stop searching
HEAD: tests → … → merge-base without a preview  deploy HEAD
HEAD: docs                                     skip
```

The walk includes HEAD and the merge-base. It follows first parents; merge
commits are compared with their first parent so merged product changes count.
Ambiguous merge-bases, including a base outside that chain, force deployment.
Renames count both old and new paths, deletions count, and empty commits skip.

`pnpm preview ci-plan --pull-request-number <number>` is read-only. It reads the
checkout's HEAD and `origin/main`, prints the classification and reason, and
writes `tests`, `deploy`, `commit`, and `slot` to `GITHUB_OUTPUT` when present.
Checkout must have full history. The commit/slot outputs are populated only for
reuse. Tests still execute the head checkout; their worker versions come from
the selected deployment.

`preview.yml` runs planning for every PR head. Only when tests are needed do
prepare, app tests, and six browser shards start together. Their setup still
overlaps deployment/readiness. Teardown starts after prepare and waits for all
consumers, as before. A planner error fails its job; it is not a successful skip.
Manual dispatch uses the same policy.

## What counts as a deployment today

The current lookup reads the PR's recorded complete fleet. Every app must be
recorded at the requested commit with its configured origin and worker identity.
The slot must still belong to this PR with an hour left on its lease. Readiness
is probed once per app, checking exact versions where the app exposes them;
lookup transport/auth errors propagate. Preparation repeats these checks and
falls back to deploying the complete head fleet if the selection is unavailable.
No lease is force-renewed for reuse.

This does not yet borrow another PR's slot or find a main preview. Existing
post-test cleanup parks the OS worker, so most completed previews are unavailable
and a tests-only push will currently fall back to deployment. Retaining reusable
previews is separate work. Erase, exact per-run test identities, worker-version
pins, result collection and failure reporting remain in place.
