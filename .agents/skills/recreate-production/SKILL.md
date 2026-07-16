---
name: recreate-production
description: Own a planned OS production recreation around a backwards-incompatible PR. Preserve selected project identities, capture old state as evidence, recreate semantic domain state through normal APIs, then verify production and wait for human sign-off. Use when asked to reset, roll, resuscitate, or recreate production for a breaking change.
---

# Recreate production

Own the whole cutover. Treat the breaking PR and old event histories as input
to an operator-authored recreation, not as a storage migration. Consult the
user at consequential forks unless they explicitly waive consultation.

## Invariants

- Keep Auth D1 and project-directory KV when exact project IDs must survive.
- Never import SQLite rows, preserve stream offsets, or replay old event
  envelopes verbatim. OS deliberately exposes no stream restore capability.
- Capture ordinary durable event histories only as evidence. Derive the desired
  current domain state, then use normal creation/connection/update APIs. Those
  APIs append new events with new offsets and run current validation.
- Do not replay stream control facts, processor outputs, old idempotency keys,
  cross-post provenance, or encrypted secret payloads. Recreate subscriptions
  through their owning domain commands.
- Secret values and integration credentials must come from an authoritative
  external source or a deliberately audited local conversion. Old ciphertext
  is not portable to a new stream offset. Stop if required material is unavailable.
- Treat the linked GitHub repository as config authority. Record its connection,
  owner, repo, installation ID, and head before cutover.
- Discard ordinary streams, schedules, files, workspaces, sandboxes, derived
  state, and other Durable Objects unless the user explicitly includes them.
- Stop and make a separate plan if Auth or its identity contract changes.
- Never expose plaintext secrets. Use a new mode-0700 temporary directory and
  mode-0600 files for captured histories and reconstruction notes.

## Capture before merge

1. Read the PR diff and inspect production. Ask which projects to retain;
   normally suggest `iterate` and personal projects that actually exist.
2. Inventory each selected project's current secrets, built-in integrations,
   subscriptions, and config repo using their normal read surfaces.
3. Export only the durable histories needed to explain that current state with
   [`scripts/export-stream-events.itx.js`](scripts/export-stream-events.itx.js).
   Run it in the relevant project context; use an admin session without a
   project context only for a deployment-wide stream. It pages ordinary
   `stream.getEvents()` calls into local files at a fixed observed head.
4. Inspect the histories locally and write an explicit reconstruction sheet:
   each desired object, its fresh create/update/connect command, the source of
   any required credential, and what will intentionally be lost. Histories are
   evidence—not executable restore payloads.
5. Call `repo.pushToGithub({})` and require its commit to equal the recorded
   config head. Summarize the reconstruction and intended losses, run
   pre-cutover checks, and obtain destructive-step approval unless already granted.

## Cut over and reconstruct

1. Ask how main's automatic deployment should be handled. If requested,
   disable or cancel it and confirm no production deploy is running.
2. Merge, check out the exact merged commit, run
   `pnpm erase-data --env prd --yes-i-mean-prd --preserve-auth`, and manually
   deploy OS from that commit. Stop on unexplained erase or deploy warnings.
3. Recreate each retained project through `session.projects.create({ projectId,
slug })`. This emits the current project birth and all required sibling
   processor births; do not hand-append historical bootstrap events.
4. Recreate selected secrets through `secrets.get(path).create/update` with
   freshly supplied material and egress policy. Reconnect integrations through
   their current connect/OAuth flows. These owning commands must recreate any
   router subscriptions and deployment-wide directory claims.
5. Recreate any other explicitly retained domain object through its current
   public `create`/configuration command. If the domain contract is itself an
   event API, append a newly constructed current event—not the old envelope.
6. Recreate the erased config repo with `repo.create()`, `repo.linkGithub()` and
   `repo.syncFromGithub({ force: true })` without a depth limit. Require the
   local head to equal the recorded GitHub head; GitHub remains authoritative.
7. Re-enable automatic deployment if it was disabled.

## Finish only after proof

Verify project IDs/routing, every recreated secret through a harmless real
consumer, every integration's connected status and external ID, directory
claims, [Slack webhook delivery](../../../docs/slack-testing.md#post-recreation-proof),
the complete [GitHub production smoke](../../../docs/github-smoke-testing.md),
project-worker boot, and AI Search indexing. Add PR-specific checks for whatever
changed. Do not trigger externally visible provider actions without approval.

Show the evidence and intentional losses to the user and ask whether production
is done. Continue repairing until they explicitly say yes. Only then delete the
local capture and end the maintenance window.
