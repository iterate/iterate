---
name: recreate-production
description: Capture or restore a selected OS project after a deliberate proof-of-concept production erase.
---

# Recreate production

Use the project-seed CLI. A seed is a small semantic snapshot, not a database
dump and not a stream export. Read
[Project seeds](../../../apps/os/docs/project-seeds.md) before operating.

## Capture

```bash
pnpm --dir apps/os cli project-seed capture --project <slug>
```

Direct capture defaults to `os/prd`. Pass `--environment <config>` or
`--file <path>` when needed. The default file is
`~/.iterate/project-seeds/<slug>.project-seed.yaml`; it is written mode 0600.

Run `project-seed check --file <path> --project <slug>` and report the
non-secret summary. Never commit or print the archive.

## Restore

```bash
doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed check \
  --file <archive.yaml> --project <slug>

doppler run --project os --config prd -- \
  pnpm --dir apps/os cli project-seed apply \
  --file <archive.yaml> --project <slug>
```

`apply` restores Auth users, minimum organization membership, the exact project
ID, hostnames, inbound-email senders, generic secrets, supported integrations,
and the config repository. It is convergent and proves its GitHub/local state
and the served config commit before returning.

GitHub is authoritative. Restore links an existing remote without an initial
push and imports its current default branch. A local-only config repository
comes from the archived file tree. Other project repositories are deliberately
outside the recovery seed.

## Boundaries

- Never export, import, or replay stream histories, offsets, processor output,
  idempotency keys, SQLite rows, or Durable Object state.
- Secret capture reads the current encrypted secret cell only. Ciphertext
  remains usable while the exact project/path binding and production
  `SECRET_ENCRYPTION_KEY` remain unchanged; `apply` decrypts locally and sends
  plaintext through the owning create/connect command for fresh encryption.
- Supported built-in integrations are Slack, GitHub, and Google. A connected
  unsupported integration makes capture fail instead of silently omitting it.
- Cloudflare custom-hostname metadata is not part of the seed. The deployed
  worker's project-hostname KV directory is the ownership and routing source of
  truth.
- Do not erase data, deploy workers, push GitHub changes, or perform externally
  visible provider smokes unless the user included that action.
- Keep the stable archive. Delete only disposable local work created during the
  run.

If `apply` fails, fix the current command or archive and rerun it. Do not repair
around it by appending old events.
