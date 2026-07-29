# Project seeds

Project seeds recreate the handful of projects worth keeping across deliberate
proof-of-concept production erases. They contain desired current configuration,
not database rows, event history, or processor state.

## Commands

Capture defaults to production and writes a mode-0600 archive:

```bash
pnpm --dir apps/os cli project-seed capture --project iterate
```

Use another environment or destination explicitly:

```bash
pnpm --dir apps/os cli project-seed capture \
  --project iterate --environment preview_2 --file /safe/place/iterate.yaml
```

Inspect and restore:

```bash
doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed check \
  --file ~/.iterate/project-seeds/iterate.project-seed.yaml \
  --project iterate

doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed apply \
  --file ~/.iterate/project-seeds/iterate.project-seed.yaml \
  --project iterate
```

`check` is local and prints no secret values. `apply` restores:

- verified Auth users, platform-admin minimums, organizations, and roles;
- the exact project ID and slug;
- direct and Cloudflare-managed hostnames plus inbound-email senders;
- generic secrets and Slack, GitHub, and Google connections;
- the config repository.

## Repositories

GitHub config repositories are references: installation ID, owner, and
repository name. GitHub remains authoritative, so restore refuses to create a
missing remote, performs no starter push, re-establishes the link on every
apply, imports the current default branch when the local head differs, and
checks that the remote head did not move during the operation.

A config repository without a GitHub link is stored as a base64 file tree in
the archive. After restoring it, the CLI waits for every
canonical/custom project route to serve that exact config commit via
`x-iterate-worker-serve`.

There is deliberately no template-diff or migration framework. If current
GitHub config does not build, the served-worker proof fails and an agent fixes
that repository normally.

## Secrets

Capture asks each Secret object for its current encrypted cell. It does not
page or fold the secret stream and never receives plaintext. The envelope is
authenticated to project ID, path, egress origins, and its original offset.

On restore, the local CLI decrypts it with the target environment's unchanged
`SECRET_ENCRYPTION_KEY` and passes the plaintext to the normal secret or
integration command. That command validates the provider identity and writes a
fresh encrypted cell. If the key or binding changed, restore fails.

The archive itself is still sensitive operational material. Keep it outside the
repository with mode 0600; do not print or commit it.

## Custom hostnames

The archive records only hostname strings and whether each is direct or
Cloudflare-managed. No Cloudflare custom metadata is captured or restored. The
deployed worker's project-hostname KV directory is the sole ownership and
routing lookup.

## Limits

The archive intentionally omits ordinary streams, agents, tasks, schedules,
workspaces, sandboxes, files outside the config repository, historical
messages, additional repositories, and derived state. Capture fails rather
than silently ignoring a connected built-in integration other than Slack,
GitHub, or Google.
