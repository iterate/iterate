# Recreate production reference

Run commands from the repository root unless a command says otherwise. Replace `<PR>`, `<projects>`,
`<file>`, and `<confirmation>` with inspected values; never guess project IDs.

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

Built-in connection control facts, their secret streams, a minimal project backbone, and selected
integration-directory facts are captured. Historical webhook/message traffic and the config-repo
journal are discarded. Export non-force-pushes the exact config head first; a rejected mirror stops the
cutover while production is still intact. Provided integrations are inventoried; their definitions
return through config-repo code. Preflight reports them for explicit verification.
The MVP also refuses a single restored stream above 8 MiB; crossing that limit
requires staged restore work before the destructive cutover.

## Cut over

After approved merge, verify the main run skipped deployment and check out the merged SHA. Then:

```bash
pnpm --dir apps/os erase-data --env prd --yes-i-mean-prd --preserve-auth
pnpm --dir apps/auth run deploy --env prd
pnpm --dir apps/os run deploy --env prd
```

The reset destroys OS Durable Objects, AI Search instances, files, and derived state. It deliberately
keeps Auth D1 and project-directory KV, and leaves sandbox container resources as unreachable orphans.

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

CLI verification is necessary but not sufficient. Derive smoke tests from the PR. Typical evidence:

- selected project ID and route resolve under the preserved Auth identity;
- every expected secret reports the same `hasMaterial` value (the value remains unreadable);
- every built-in and provided integration inventory entry is present, plus safe connection status/API
  probes where available;
- config repo points to the expected GitHub repository and its current head runs the project worker;
- AI Search returns a known config-repo fact after reindexing;
- no supposedly discarded streams/files/workspaces are accidentally treated as restored.

`hasMaterial` proves ciphertext was restored, not that a breaking encryption or AAD change can decrypt
it. For each secret shape affected by the PR, use the safest real consumer or provider-status probe that
forces decryption without exposing the value. If no non-destructive probe exists, tell the user exactly
what remains unproved and ask before causing an external side effect.

For Telegram, the existing webhook normally survives because the production URL and derived webhook
secret are unchanged. Verify it; reconnect only with user approval if the breaking PR changed either.

Keep repairing and re-running smoke tests until the human accepts the cutover. Delete `<file>` only after
their explicit “yes, done.”
