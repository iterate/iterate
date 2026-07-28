---
name: recreate-production
description: Capture stable local recovery archives for selected OS projects before a deliberate data erase, then restore those projects while keeping each linked GitHub config repository authoritative. Use when asked to back up, capture, restore, recreate, resuscitate, or roll production projects such as iterate in the proof-of-concept reset workflow.
---

# Capture and restore production projects

Capture or restore one named project with a local project-seed archive. The
archive describes desired identity and configuration; it is not a database
dump or an event-history backup. GitHub supplies current contents for linked
repositories; local-only repositories are stored as exact file trees.

Read [Project seeds](../../../apps/os/docs/project-seeds.md) before operating.
Use [the example archive](references/project-seed.example.yaml) only as a shape;
never infer real IDs, users, credentials, or repository names from it.

## Boundaries

- A restore request does not authorize an erase, deployment, GitHub write, or
  externally visible provider smoke. Do those only when the user explicitly
  includes them.
- A capture request authorizes read-only production inspection and writing the
  named/default local archive. It does not authorize changing production.
- Never archive or replay stream histories, processor output, idempotency
  keys, SQLite rows, or Durable Object state. The capture CLI may read only
  secret creation/update facts to fold each current ciphertext envelope.
- Recreate subscriptions only through their current owning domain commands.
  Never restore stream-control facts, copy provenance, or delivery offsets.
- Never append archived ciphertext directly. It is authenticated to its source
  project/path/egress/offset. `apply` must unwrap it in local process memory
  with the unchanged target environment key, then pass plaintext to the owning
  command so OS encrypts a fresh destination envelope.
- Never print credential values or copy the archive into the repository.
- Never delete the stable archive. Remove only temporary decrypted files and
  clones created during this run.
- The archive is a minimum desired set for organization membership and inbound
  email senders. Omitted entries are not removed. Integration ownership is
  exact: never steal a provider identity from another project.
- When a repository is linked to GitHub, GitHub is authoritative. Restore must
  not push starter state, create a missing remote, or force-push. A local-only
  repository is restored from the archived file tree instead.
- Provided integrations and other config-derived capabilities come back from
  the restored config repository.

## Capture workflow

1. Resolve an explicit project slug/ID and destination when the user supplied
   them. Otherwise use the CLI prompt and default
   `~/.iterate/project-seeds/<slug>.project-seed.yaml`. Do not search broad
   home-directory paths for archives.
2. From the repository root, capture one project:

   ```bash
   pnpm --dir apps/os cli project-seed capture \
     --project <slug-or-prj-id> \
     --file <archive.yaml>
   ```

   A direct invocation defaults to `os/prd`. Use `--environment <config>` for
   another environment and `--force true` only when replacing the exact file
   is intended. The result is mode 0600.

3. Run `project-seed check` on the result and report its non-secret summary.
   Capture must fail loudly on unsupported connected integrations or state; do
   not edit out the error and call the archive complete.
4. Store the archive outside the repository. Do not commit, upload, or print
   it. It remains useful across data erases while its semantic inputs and the
   target environment encryption key remain valid.

## Restore workflow

1. Obtain the explicit archive path and project slug/ID. Do not search broad
   home-directory paths for secret files. If inline material is present,
   require mode 0600.
2. From the repository root, validate and display the non-secret plan:

   ```bash
   doppler run --project os --config prd -- \
     pnpm --dir apps/os cli project-seed check \
     --file <archive.yaml> --project <slug-or-prj-id>
   ```

   Stop on a target-environment mismatch, missing reference, duplicate, invalid
   sender rule, unsupported built-in secret path, or config-repo installation
   mismatch.

3. Run the read-only compatibility gate before applying:

   ```bash
   doppler run --project os --config prd -- \
     pnpm --dir apps/os cli project-seed preflight \
     --file <archive.yaml> --project <slug-or-prj-id>
   ```

   This disposable checkout clones a GitHub source or materializes an archived
   local source, runs install/typecheck/tests, and evaluates explicit config
   migration rules. For GitHub it also compares current `main` with the
   archived working head. Inspect current OS changes affecting `packages/iterate`, the itx
   contract, dynamic-worker builds, or `apps/os/config-repo-template` when the
   report or the breaking PR calls for it. Treat raw template differences as
   informational: project repos intentionally diverge. If a check or explicit
   migration requires a GitHub change, explain it and ask before creating a
   commit, push, or PR. Do not continue with a knowingly incompatible repo.

4. If production does not yet expose the Auth/OS restore methods used by the
   current CLI, report the exact required worker deployments and obtain
   deployment approval before continuing.
5. Apply the seed:

   ```bash
   doppler run --project os --config prd -- \
     pnpm --dir apps/os cli project-seed apply \
     --file <archive.yaml> --project <slug-or-prj-id>
   ```

   Before its first write, the CLI repeats the config-repo compatibility gate
   and pins the observed GitHub head for the link/reset operation. It then
   converges Auth users, minimum platform-admin privilege, and minimum
   organization roles, recreates the exact
   project ID, restores direct and Cloudflare-managed hostnames plus
   inbound-email senders,
   creates/updates generic secrets, validates and reconnects supported
   integrations, restores each local repository file tree, links each
   pre-existing GitHub repo without an initial push, resets local Artifacts
   state from GitHub, and proves every returned state.
   In particular, require the preflight remote head, post-reset local/remote
   heads, and every canonical/direct-host
   `x-iterate-worker-serve` header to agree. The captured head is reported
   separately and may be an older ancestor. A successful pull/reset without
   the served-worker proof is not a successful restore. Retry only the
   explicitly marked cold-building response; never wave through an eventual
   success after a build failure, serve error, wrong SHA, or unclassified
   response. Preserve the reported Cloudflare Ray ID for diagnosis.
   It obtains Auth's service token from `auth/<targetEnvironment>` in Doppler;
   never paste that token into command arguments.

6. Treat a successful CLI result as the structural proof, not the whole
   product proof. Check project routing and run harmless provider reads. For
   `iterate`, use the Slack verifier and
   [GitHub production smoke](../../../docs/github-smoke-testing.md). Ask before
   sending a Slack mention, email, or creating a GitHub smoke PR.
7. Report restored state, unsupported/omitted state, compatibility evidence,
   and any intentional loss. Do not declare the project working while a check
   is unexplained or an expected semantic input is absent.

## Failure handling

- Rerun `check`, correct the archive or current code, then rerun `apply`.
  Applying is convergent; do not repair around a failed invariant by appending
  events manually.
- Slack, GitHub, and Google credentials are validated against the archived
  provider identity before their connection is recorded. Telegram validates
  through its normal connect command. Other unsupported connection types
  require their current interactive connect flow.
- If GitHub is missing or inaccessible, stop. The CLI preflights its HEAD
  before linking and proves that linking did not move it.
- If an archive schema becomes obsolete, update the schema and an explicit
  local conversion. Do not add runtime compatibility fallbacks.
- If ciphertext unwrap fails, verify the exact archive/environment first. A
  rotated or lost `SECRET_ENCRYPTION_KEY` cannot decrypt the old envelope;
  never bypass this by replaying its event at a new offset.
