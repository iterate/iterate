# Worker health runbook

Ad-hoc admin scripts for the two diagnostics the platform records facts for
but deliberately ships no resolver methods for (core-simplicity call, PR
#2519: facts are core, compositions are scripts). Run them with the app CLI
against any environment:

```bash
doppler run --config prd -- pnpm cli itx run --project <slug> ./script.ts
```

Both are copy-paste starting points, not product surface. If either ever
needs to become one, resurrect the full implementations (with spec suites)
from the pre-reduction commits of PR #2519 — see the task file's
"reduced to facts-only" section for the exact commits and design guidance.

## Cross-stream subscription health rollup

Sweeps every stream's subscription catalog and tiers the troubled ones.
`lastErrorAt` rides the ordinary list read (recorded beside `last_error` at
write time; null = a row from before the column existed — unknown age, not
"just now"). Each stream dialed is a Durable Object wake: keep sweeps
on-demand and bounded, never on a timer — that is why this is a script.

```ts
export default async function subscriptionHealth(itx: Itx) {
  const streams = await itx.streams.list();
  const report = [];
  for (const { path } of streams) {
    const entries = await itx.streams.get(path).subscriptions.list();
    for (const entry of entries) {
      const tier =
        entry.status === "halted"
          ? "halted" // red: delivery durably gave up; resume it
          : entry.nextAttemptAt !== null
            ? "lagging" // amber: failing and backing off right now
            : entry.lastError !== null
              ? "informational" // standing lastError, delivery flowing again
              : null;
      if (tier === null) continue;
      report.push({
        path,
        name: entry.name,
        tier,
        lag: entry.lag,
        attempt: entry.attempt,
        lastError: entry.lastError,
        lastErrorAt: entry.lastErrorAt,
      });
    }
  }
  return report;
}
```

Bound the sweep on big projects (filter `streams` to `/agents/**` you care
about plus `/`, `/repos/config`, `/scheduler/primary`,
`/integrations/email`). Repair verbs once you find trouble:
`streams.get(path).resumeSubscription` / `setSubscriptionCursor` (the
dashboard's root-stream sheet wraps the same verbs).

## Three-way template re-sync sketch

Reconcile a config repo against the template it was created from. The
durable `createRequest` (repo processor state) is the intent:
`github-public-template` carries `{owner, repo, path, ref}`; an `empty`
create was seeded from `configs/default` of iterate/iterate (resolve the
path from `CONFIG_REPO_TEMPLATE_CATALOG` rather than trusting this prose).

```ts
export default async function syncFromTemplate(itx: Itx) {
  const repo = itx.repo; // /repos/config
  const { state } = await repo.processor.snapshot();
  // 1. The base: template content at the last sync. Without a recorded
  //    base, the seed/root commit approximates it (repo.log, walk to the
  //    parentless commit, readFile({ commitOid }) per path).
  // 2. The latest: fetch the template folder from GitHub at its default
  //    branch HEAD (strip a pinned 40-hex ref — that is a preview pin).
  // 3. Per file in base ∪ latest:
  //    - template unchanged vs base        -> keep the repo's copy
  //    - repo copy === latest already      -> nothing to do
  //    - repo copy === base (user never touched it) -> take latest
  //    - both changed                      -> SKIP and report; never merge
  // 4. Commit the adoptable changes in ONE normal commit via
  //    repo.commitFiles({ message, changes }) — never a reset.
  void state.createRequest; // the template intent, shapes above
}
```

Caveats the product method handled and a script must respect:

- **Race**: nothing stops another commit landing between your head read and
  `commitFiles`. Small window, ugly outcome (your commit clobbers theirs at
  the file level). A general `expectedHeadOid` compare-and-swap option on
  `commitFiles` is the right platform-side cure if this graduates.
- **Base tracking**: stamp the sync commit message with git trailers
  (`Template-Reference: github:owner/repo#path:...`,
  `Template-Commit: <40-hex template oid>`) and derive the next sync's base
  from the newest trailer in `repo.log` — survives mirrors and re-imports,
  no contract event needed.
- **Package substitution**: seeds re-point `package.json` pkg.pr.new specs
  per deployment (`projectRepoSeedFiles`, src/pkg-pr-new.ts). Apply the same
  substitution to fetched template content before diffing or every sync
  reports package.json as both-changed.
