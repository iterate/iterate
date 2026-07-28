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
- The reconstruction program lives outside deployed OS. It may read the export
  page files, select the small set of semantic facts named in the reconstruction
  sheet, and map them to freshly constructed current-version event inputs or
  public API calls. The export itself is never an executable replay payload.
- Do not replay stream control facts, processor outputs, old idempotency keys,
  copy provenance, or encrypted secret payloads. Recreate subscriptions
  through their owning domain commands.
- Secret values and integration credentials must come from an authoritative
  external source or a deliberately audited local conversion. Old ciphertext
  is not portable to a new stream offset. Stop if required material is unavailable.
- Never reconstruct a built-in integration by hand-creating its secret and
  appending `connected` or directory-claim events. The owning connect command
  is the atomic invariant boundary: it validates fresh credentials, writes the
  secret, creates the router/subscription, records lifecycle state, and claims
  webhook ingress in the supported order.
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
2. Record each selected project's exact ID, canonical slug, organization slug,
   and an organization-member principal the operator can mint a session for.
   Inventory its current secrets, built-in integrations, subscriptions, and
   config repo using their normal read surfaces.
3. Export only the durable histories needed to explain that current state with
   [`scripts/export-stream-events.itx.js`](scripts/export-stream-events.itx.js).
   Run it in the relevant project context; use an admin session without a
   project context only for a deployment-wide stream. It pages ordinary
   `stream.getEvents()` calls into local files at a fixed observed head.
4. Inspect the histories locally and write an explicit reconstruction sheet:
   each desired object, its fresh create/update/connect command, the source of
   any required credential, and what will intentionally be lost. Histories are
   evidence—not executable restore payloads. Write the external reconstruction
   script against the export here: select only the required semantic facts and
   construct new current-version inputs without copied offsets, timestamps,
   source/provenance, idempotency keys, or stream-control events.
5. Call `repo.pushToGithub({})` and require its commit to equal the recorded
   config head. Summarize the reconstruction and intended losses, run
   pre-cutover checks, and obtain destructive-step approval unless already granted.

## Cut over and reconstruct

1. Ask how main's automatic deployment should be handled. If requested,
   disable or cancel it and confirm no production deploy is running.
2. Merge, check out the exact merged commit, run
   `pnpm erase-data --env prd --yes-i-mean-prd --preserve-auth`, and manually
   deploy OS from that commit. Stop on unexplained erase or deploy warnings.
3. For each retained project, mint or obtain a user-authenticated itx session
   whose claims include the project's preserved organization, then call
   `session.projects.create({ projectId, slug, organizationSlug })`. Auth
   idempotently adopts the existing exact ID only when both its organization
   and canonical slug match; OS then primes the preserved association and emits
   the current project birth plus all required sibling processor births. Do not
   use an admin session for this step: caller-supplied admin projects are
   intentionally organization-less test/operator fixtures. Stop on any mismatch,
   and do not hand-append historical bootstrap events.
4. Recreate selected non-integration secrets through
   `secrets.get(path).create/update` with freshly supplied material and egress
   policy. Reconnect integrations only through their current connect/OAuth
   flows. Do not seed a Slack connection from
   `APP_CONFIG_INTEGRATIONS__SLACK.botToken`: that optional deployment fallback
   may be stale and is not project restoration material. Do not hand-append a
   provider's `connected`, processor-birth/subscription, or directory-claim
   events. If interactive OAuth cannot be completed, the reconstruction is
   incomplete and the maintenance window stays open.
5. Recreate any other explicitly retained domain object through its current
   public `create`/configuration command. If the domain contract is itself an
   event API, let the external reconstruction script select the relevant old
   fact and append a newly constructed current event—not the old envelope.
6. Recreate the erased config repo with `repo.create()`, `repo.linkGithub()` and
   `repo.syncFromGithub({ force: true })` without a depth limit. `linkGithub()`
   attempts an initial mirror push, so bracket it with a GitHub ref check: the
   recorded remote head must still exist, and if the link advanced the default
   branch, restore that ref to the recorded head before syncing. Require both
   the remote default branch and local Artifacts head to equal the recorded
   head; GitHub remains authoritative.
7. Re-enable automatic deployment if it was disabled.

## Finish only after proof

Verify project IDs/routing, every recreated secret through a harmless real
consumer, every integration's connected status and external ID, directory
claims, [Slack webhook delivery](../../../docs/slack-testing.md#post-recreation-proof),
the complete [GitHub production smoke](../../../docs/github-smoke-testing.md),
and project-worker boot. Add PR-specific checks for whatever
changed. Do not trigger externally visible provider actions without approval.

### Production website (`iterate.com`)

The company website is the `iterate` project worker, reached on the owned apex
via Worker routes `iterate.com/*` and `*.iterate.com/*` → `os-prd` (see
`ownedProjectCustomApexes` in root `envs.ts`). Those routes alone are not
enough: ingress still needs the project-directory KV registration

```text
hostname:iterate.com → { id, slug, organizationId, name } of project "iterate"
```

Re-prime that key after every production erase (same shape as `slug:iterate`).
Do **not** register `hostname:www.iterate.com` — the custom-domain parent
fallback would treat `www` as an app slug and the seed homepage would emit
`tasks.www.iterate.com` links. Do not add a www↔apex redirect unless a human
explicitly asks for one.

For Slack, run
[`scripts/verify-slack-connection.itx.js`](scripts/verify-slack-connection.itx.js)
without a project context immediately after OAuth. It requires a successful
`auth.test`, an exact team-id match, connected lifecycle state, and the matching
deployment-wide directory claim. Only then send a **new** mention smoke. A
validly signed webhook delivered before the claim exists is ACKed and ignored
by design and Slack will not replay it after association, so an earlier message
is never proof of the re-established path.

Show the evidence and intentional losses to the user and ask whether production
is done. Continue repairing until they explicitly say yes. Only then delete the
local capture and end the maintenance window.
