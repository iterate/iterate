# Recreate production reference

Run commands from the repository root unless a command says otherwise. Replace `<PR>`, `<projects>`,
`<file>`, and `<confirmation>` with inspected values; never guess project IDs.

## Preconditions and boundary

The recovery RPC/CLI/skill must already have reached production through an ordinary deployment before
it can capture a later breaking change. Do not gate the preparatory recovery PR itself. This is an
OS-only procedure: if `<PR>` changes Auth code, Auth data, or the identity contract, stop and agree a
separate cutover with the user. Establish a one-person maintenance window; there is no global lock.

## Gate the merge

```bash
gh label create skip-main-ci-deploy --color D93F0B \
  --description "Skip automatic main Auth/OS deploy for a planned manual cutover" --force
gh pr edit <PR> --add-label skip-main-ci-deploy
gh pr view <PR> --json labels,headRefOid,mergeStateStatus
```

`.depot/workflows/deploy-os.yml` asks GitHub which PR produced the pushed main commit. A labelled PR
leaves the job green but skips the Auth/OS deploy steps. `workflow_dispatch` remains an explicit deploy.
Do not rely on racing a CI cancellation.

## Capture and preflight

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli \
  recreate-production export-projects --projects <projects> \
  --breaking-change <PR> --out <file>

doppler run --project os --config prd -- pnpm --dir apps/os cli \
  recreate-production preflight --file <file>
```

The package includes exact stream coordinates and offsets. Never change a project ID, stream path, or
secret-event offset: secret ciphertext authenticates all three. A target schema conversion may change
payload shape only when its cryptographic fields and coordinate remain intact. Transform a copy, keep
the original, rerun preflight, and show the user the diff.

Built-in connection control facts and status/external IDs, their secret streams, email sender policy,
project egress/human-approval policy, a minimal project backbone, and selected active
integration-directory claims are captured. Waitrose is secret-backed and has no fake connection
journal. Historical webhook/message traffic and the config-repo journal are discarded. Export
non-force-pushes the exact config head first; a rejected mirror stops the cutover while production is
still intact. A provided integration makes preflight fail: add a PR-specific rehydrator or consult the
user before proceeding.
The MVP also refuses a single restored stream above 8 MiB; crossing that limit
requires staged restore work before the destructive cutover.

## Cut over

After approved merge, verify the main run skipped deployment and check out the merged SHA. Then:

```bash
pnpm --dir apps/os erase-data --env prd --yes-i-mean-prd --preserve-auth
pnpm --dir apps/os run deploy --env prd
```

The reset destroys OS Durable Objects, AI Search instances, files, and derived state. It deliberately
keeps Auth D1 and project-directory KV, does not deploy Auth, and leaves sandbox container resources as
unreachable orphans. Schedules, ordinary streams, email messages, custom domains,
`/cloudflare/events`, and other unlisted global streams are intentional losses. If erase reports a
warning or partial failure, stop, inspect, and rerun it before deploy; do not reinterpret a warning as
success.

## Restore and verify

Use the exact confirmation emitted by export/preflight:

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli \
  recreate-production restore --file <file> --confirm '<confirmation>'

doppler run --project os --config prd -- pnpm --dir apps/os cli \
  recreate-production verify --file <file>
```

Restore uses GitHub as authoritative and calls `syncFromGithub({ force: true })` without `depth`, so
GitHub retains and supplies all history. If a repository is too large for the Durable Object memory
limit, stop and ask whether to use a bounded depth while keeping full history in GitHub; do not silently
truncate.

CLI verification proves the saved metadata and core routing mechanics:

- selected project ID and route resolve under the preserved Auth identity;
- every expected secret reports the same `hasMaterial` value and decrypts inside its Secret Durable
  Object without returning plaintext;
- every built-in integration entry has the saved connected state and external ID;
- selected active integration-directory claims exactly match the package, proving Slack team-to-project
  webhook routing data is back;
- config repo points to the expected GitHub repository, has the exact exported head, and its project
  worker boots after the inward sync.

CLI verification is necessary but not sufficient. Derive smoke tests from the PR. Additional evidence:

- harmless provider-specific calls work for each connected built-in integration;
- Slack's connection status and an inbound webhook route work end to end; do not post a visible message
  without approval;
- AI Search returns a known config-repo fact after reindexing;
- no supposedly discarded streams/files/workspaces are accidentally treated as restored.

The decryptability probe proves the ciphertext/AAD/key still opens, not that every secret field still
matches a changed consumer schema. For each secret shape affected by the PR, use the safest real
consumer or provider-status probe. If no non-destructive probe exists, tell the user exactly what
remains unproved and ask before causing an external side effect.

For Telegram, the existing webhook normally survives because the production URL and derived webhook
secret are unchanged. Verify it; reconnect only with user approval if the breaking PR changed either.

Keep repairing and re-running smoke tests until the human accepts the cutover. Delete `<file>` only after
their explicit “yes, done.”
