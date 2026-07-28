# Project seeds

A project seed is a small, stable, local description of the production state
that matters after an intentional proof-of-concept reset. It rebuilds semantic
state through current Auth and itx commands. It is not a Durable Object dump,
stream export, or event replay.

Capture it before the erase:

```bash
# Defaults to os/prd and ~/.iterate/project-seeds/iterate.project-seed.yaml.
pnpm --dir apps/os cli project-seed capture --project iterate

# Explicit environment, destination, and overwrite:
pnpm --dir apps/os cli project-seed capture \
  --project iterate \
  --environment preview_3 \
  --file /absolute/path/iterate.project-seed.yaml \
  --force true
```

On a human terminal, omitting a required option such as `--project` opens the
CLI's built-in prompt. Agents and automation should pass flags. Capture refuses
to overwrite an existing file without `--force true` and always makes the
result mode 0600. Its default archive directory is outside the Git checkout and
is mode 0700.

After an erase, validate and apply the saved file:

```bash
# Schema/cross-reference check and non-secret plan.
doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed check \
  --file /absolute/path/iterate.project-seed.yaml --project iterate

# Read-only config-repo compatibility gate. This clones GitHub or materializes
# a local archive in a disposable directory and runs fresh checks.
doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed preflight \
  --file /absolute/path/iterate.project-seed.yaml --project iterate

# After preflight reports ready:
doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed apply \
  --file /absolute/path/iterate.project-seed.yaml --project iterate
```

`apply` refuses to run unless the archive's `targetEnvironment` equals the
active `DOPPLER_CONFIG`. It returns identifiers and proof metadata, never
credential values.

## What capture reads

`capture` authenticates to OS with the selected environment's admin secret and
to Auth with its internal service token. It reads:

- the exact project ID and organization;
- organization members, user email/name/image, platform-admin status, and
  member roles;
- active direct and Cloudflare-managed hostnames plus inbound-email sender
  rules;
- generic secret policy and the newest encrypted material envelope;
- connected Slack, GitHub, Google, and Telegram identity plus the encrypted
  credential envelopes that cannot be minted again;
- Telegram user access rules; and
- every project repository: linked GitHub identity and its
  last-known-working `main` head, or an exact base64 file tree for a local-only
  repository.

Provided integrations and other configuration-derived capabilities are rebuilt
from the restored config repository rather than copied separately.

For a secret, capture reads only its `secret/created` and `secret/updated`
facts through one offset-pinned processor snapshot, folds them to the current
policy/envelope, and proves that fold against the snapshot. It writes neither
events nor plaintext to the archive. Messages, agents, schedules, runtime
files, and other product history are not downloaded.

Capture fails instead of emitting a misleading partial archive when the
selected project has a Waitrose connection, egress approval rules, active
human-approval keys, a non-active Cloudflare hostname, or a retained secret
with no current material.

## What a seed restores

For the selected project, `apply` runs these convergent boundaries in order:

1. Repeat the read-only config-repository preflight and pin its current head
   before making any Auth or OS write.
2. Upsert each declared organization member as a verified Auth user and
   re-grant platform-admin privilege where the archive requires it. A stale
   archive never demotes an existing platform admin.
3. Create or update the organization and make each declared role exact.
   Members omitted from the seed are retained.
4. Create the organization-bound project with the archive's exact `prj_*` ID
   and prove its ID, slug, and organization.
5. Restore direct hostnames and adopt/provision Cloudflare-managed hostnames.
   The deployed hostname KV directory is the ownership/routing authority;
   Cloudflare custom-hostname metadata is not used.
6. Add and prove the declared inbound-email sender allowlist. The project
   inbox address is derived from its slug and the deployment's first project
   hostname base; it has no separate mailbox ID or credential.
7. Create or update generic secrets and prove their non-secret metadata.
8. Restore supported integrations through their owning connection commands.
9. Restore every repository. Local sources replace the repository with the
   exact archived file tree. GitHub sources link the pre-existing remote
   without an initial push, reset local Artifacts state from GitHub, and prove
   the pinned remote head did not move.

The born project API key is generated afresh by normal project creation. It is
intentionally rejected as a generic seed secret.

Organization members and email senders use minimum-set semantics because an
old archive must not silently remove a developer or close a sender added later.
Secret paths in the selected project are converged exactly when declared, but
undeclared paths are not deleted. A provider-side integration ID has one exact
project owner; restore refuses to steal it.

## Archive shape

The maintained shape is
[project-seed.example.yaml](../../../.agents/skills/recreate-production/references/project-seed.example.yaml).
A single archive can hold several users, organizations, and projects; `--project`
selects one slug or exact ID and touches only its organization and state.

Top-level fields:

| Field               | Meaning                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `version`           | Archive schema version; currently `1`.                                                         |
| `targetEnvironment` | Exact Doppler config, normally `prd`.                                                          |
| `users`             | Stable login emails, display names, optional image URLs, and minimum platform-admin privilege. |
| `organizations`     | Slug/name plus the minimum desired member-role set. Every organization needs an owner.         |
| `projects`          | Exact identity and semantic configuration for each retained project.                           |

Project fields:

| Field                        | Meaning                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`, `slug`, `organization` | Exact Auth/project-directory identity.                                                               |
| `directHostnames`            | Platform-owned apexes whose Worker routes already point to OS.                                       |
| `cloudflareHostnames`        | Active Cloudflare-for-SaaS hostnames to adopt/provision and register in the hostname KV directory.   |
| `email.allowedSenders`       | Exact addresses or `*@domain` rules for inbound mail.                                                |
| `secrets`                    | Non-integration secret path, egress URLs, material source, refresh policy, and immutable visibility. |
| `integrations`               | Slack, GitHub, Google, or Telegram connection inputs and provider IDs.                               |
| `configRepo`                 | GitHub identity/head or a local file tree for `/repos/config`.                                       |
| `repositories`               | Additional `/repos/*` repositories, each with a GitHub identity/head or local file tree.             |

Every GitHub repository `installationId` must match a GitHub integration in
the same project. Duplicate IDs, slugs, repository paths, file paths, secret
paths, hostnames, members, or sender rules fail `check`.

## Credential storage

Raw OS secret ciphertext cannot be appended into a new stream position. AES-GCM
authenticates the source project ID, secret path, allowed egress origins, and
exact source offset as additional data. The same encryption key is necessary,
but those source coordinates are necessary too.

A captured archive therefore stores both the ciphertext envelope and its
original binding:

```yaml
material:
  source: ciphertext
  encrypted:
    algorithm: AES-GCM-SHA256+SECRET-CELL-V1
    ciphertext: <base64>
    iv: <base64>
  binding:
    projectId: prj_example
    path: /secrets/example/openai
    egressOrigins:
      - https://api.openai.com
    offset: 42
```

Capture never decrypts this envelope. During `apply`, the local CLI uses the
target environment's `SECRET_ENCRYPTION_KEY` and captured source binding to
unwrap it in process memory. It then calls the current owning secret or
integration command with the value; that command validates it where
applicable and encrypts a fresh envelope bound to the new destination offset.
Plaintext is never written to disk or returned in CLI output.

This makes an archive portable across deliberate database erases while that
environment retains the same encryption key and supports the archived
algorithm. Rotating or losing the key makes old archives unusable unless the
old key is retained for an explicit migration. Recapture important projects
before a planned key rotation.

Hand-maintained archives may instead refer to environment variables:

```yaml
material:
  source: env
  name: ITERATE_OPENAI_API_KEY
  encoding: string # default; use json for structured material
```

Or, as a last resort, contain plaintext:

```yaml
material:
  source: inline
  value: plaintext-or-structured-value
```

Any archive containing ciphertext or inline material must be mode 0600;
`capture`, `check`, and `apply` enforce this. Independent file encryption with
age or 1Password remains optional defense in depth.

Never commit the real archive. The CLI labels inline/environment sources in
its plan but does not return their values.

Generic secrets cannot use `/secrets/integrations/**` or
`/secrets/project-api-key`. Built-in integration credentials have additional
invariants—provider validation, lifecycle facts, subscriptions, webhook
claims—and must go through the integration restore path.

## Integration support

| Provider          | Seed material                                  | Validation and result                                                                                        |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Slack             | Bot token plus exact team ID                   | `auth.test` must return that team before a fresh secret, lifecycle journal, and directory claim are written. |
| GitHub            | Exact installation ID                          | OS mints a token with the deployment GitHub App, then restores the connection secret and claim.              |
| Telegram          | Bot token plus optional user allowlist         | The normal `connectTelegram` command validates `getMe`, installs the webhook, and applies the allowlist.     |
| Google/Gmail      | Refresh-token object plus exact Google user ID | Refreshes the token, reads Google userinfo, requires the same user ID, then records a fresh connection.      |
| Other connections | Not in schema version 1                        | Complete the current interactive connect flow.                                                               |

The optional deployment Slack bot token is not restoration material. A seed
must name the actual project token source and exact Slack team ID.

## Repository sources

For a GitHub source, the seed stores repository identity plus the `main`
commit that was both live in OS and current on GitHub at capture time. It does
not store that repository's contents and `apply` does not pin the old commit.
The captured head is a comparison point: `preflight` lists later commits,
rejects a force-pushed/divergent history, and restores the current compatible
GitHub head. A local source instead contains an exact file tree and never
contacts GitHub.

Before `apply`, `project-seed preflight` creates a fresh temporary checkout,
performs the config's normal dependency install, and runs its typecheck and
tests when present. A GitHub source is cloned and compared with current
history; a local source is materialized from the archive. Only `gh repo clone`
receives GitHub auth;
dependency and repository scripts receive a minimal environment and an
isolated home directory, not Doppler's production secrets or the operator's
GitHub credentials. The command also reports package/`tsconfig.json`/`worker.ts`
differences from the current starter template.

That template comparison is deliberately informational. Project workers are
expected to diverge; a raw diff cannot decide what to merge. A breaking
OS/SDK/template change must add an explicit deterministic migration rule to
the preflight implementation in the same PR. A required rule or failed
install/typecheck/test is a blocker. Any GitHub commit, push, or PR to resolve
one still needs separate user authorization.

For a GitHub config, `apply` repeats the compatibility gate before its first
Auth or OS write, then requires GitHub to retain that exact preflight head
through the link/reset operation. During that operation, OS:

1. reads the existing repository's default branch and head;
2. links it with `initialPush: false`;
3. proves linking did not move the remote head;
4. destroys and recreates only the local Artifacts repo from GitHub;
5. proves local and remote branch/head equality;
6. polls the canonical project hostname and every restored custom hostname
   until each response's trusted `x-iterate-worker-serve` header names that
   exact head, then rechecks local and remote heads.

A missing GitHub repository fails before the link call. Seed restore never
creates or pushes starter history, and it never replaces project-specific
config with the current template. The result reports four distinct facts: the archived
last-known-good head, the current remote head approved by preflight, the local
head returned by `resetFromGithub`, and the head actually served at each URL.
The archived head may be older; the other three must be identical. Lazy worker
build polling retries only the explicitly modelled
`503`/`x-iterate-worker-building: 1` state and has a bounded four-minute
deadline. A wrong commit, build failure, platform serve error, network failure,
or other unmodelled response fails immediately with its status and trusted
headers plus its Cloudflare Ray ID instead of being hidden behind retries or
treating a successful GitHub reset as sufficient proof.

## Maintaining an archive

Run `capture` once while the important project works, store the resulting file
outside the repository, and test it with `check`. It is a stable recovery
snapshot rather than a continuously synchronized backup: ordinary stream and
GitHub commits do not require a recapture. `preflight` explains GitHub changes
since that captured working head. Adding a user, role, hostname, secret,
integration, or access rule does require a recapture.

The file does not need to track ordinary streams or be updated as GitHub
advances. Run `project-seed check` after editing it and run `preflight` before
every restoration. When a future contract needs a new semantic field,
bump/convert the archive schema explicitly rather than adding a deployed
compatibility fallback.

Auth sessions and social-provider account rows are intentionally recreated by
the next login rather than archived. The seed restores the user records,
minimum platform-admin privilege, organization membership, roles, and project
authorization. Messages, schedules, runtime files, workspaces, sandboxes,
agent history, and derived processor state are not restored.
