---
name: recreate-production
description: Own a planned OS production recreation around a backwards-incompatible PR. Preserve selected project IDs, encrypted secrets, every built-in integration connection, Slack webhook routing, and GitHub-backed config repos; then verify production and wait for human sign-off. Use when asked to reset, roll, resuscitate, or recreate production for a breaking change.
---

# Recreate production

Own the whole cutover. Treat the breaking PR as input and use judgment: this is a
smart-agent runbook, not an unattended migration system. Consult the user at
consequential forks unless they explicitly waive consultation.

## Scope

- Keep Auth D1 and project-directory KV so every project keeps its exact ID.
- For each selected project, retain all encrypted secret streams and every built-in
  integration connection. Retain the active entries in the global
  `/integrations/_directory`; Slack and other webhooks route through it.
- Treat the linked GitHub repository as config authority. Record its connection,
  owner, repo, installation ID, and head; mirror the exact head before cutover and
  sync all history inward after restore.
- Retain only the minimum root-stream facts required to bootstrap the project under
  its old ID. Discard ordinary streams, schedules, files, workspaces, sandboxes,
  derived state, and other Durable Objects unless the user adds them for this PR.
- Stop and make a separate plan if Auth or its identity contract changes. Ask how to
  recreate provided integrations; their definitions are not built-in connections.
- Never expose plaintext secrets. Recovery packages contain ciphertext but are still
  sensitive: use a new mode-0700 temporary directory and mode-0600 files.

## Capture before merge

1. Read the PR diff and inspect production. Ask which projects to retain; normally
   suggest `iterate` and any Jonas/Misha personal projects that actually exist.
2. Confirm these recovery verbs are already deployed by calling
   `session.streamRecovery.get({ projectId, path }).exportForRecovery()` read-only
   through `pnpm cli itx run` in production.
   A breaking PR cannot introduce and use this plumbing in the same deployment.
3. Create a temporary itx script rather than adding a permanent orchestrator. For
   each selected project, inventory secrets, built-in integrations, and the config
   repo. Export the root, every listed `/secrets/**` stream, every built-in connection
   stream, and the global integration directory. Page with a fixed `throughOffset`;
   save `{format, version, stream, events, highestAssignedOffset: throughOffset}`.
4. Reduce the package deliberately: keep bootstrap facts in `/`, secret journals
   intact, current integration lifecycle/subscription facts, and only active global
   claims for retained project IDs. Do not renumber events: encrypted secret material
   authenticates its project ID, path, and offset.
5. Compare every retained event with the post-merge contracts. Propose any necessary
   transformation to the user. Stop if compatibility is ambiguous or would change a
   secret coordinate.
6. Call `repo.pushToGithub({})` and require its commit to equal the local config head.
   Summarize the package and intended losses, run pre-cutover checks, and obtain the
   user's destructive-step approval unless already granted.

## Cut over and restore

1. Ask the user how they want main's automatic deployment handled. If requested,
   disable or cancel it before merging and confirm no production deploy is running.
2. Merge, check out the exact merged commit, run
   `pnpm erase-data --env prd --yes-i-mean-prd --preserve-auth`, and manually deploy
   **OS only** from that commit. Stop on unexplained erase or deploy warnings.
3. Use a temporary itx script to call `restoreFromRecovery()` in this order: project
   root, secret streams, integration streams, then the global directory. The target
   code validates and folds the complete journal before replacing storage.
4. For each project, call `repo.linkGithub()` with the recorded connection/owner/repo,
   then `repo.syncFromGithub({ force: true })` with no depth. Let GitHub win.
5. Re-enable automatic deployment if it was disabled.

## Finish only after proof

Verify project IDs/routing, every secret through a harmless real consumer, every
integration's connected status and external ID, active directory claims, Slack
webhook delivery, an authenticated GitHub request, equal local/remote config heads,
project-worker boot, and AI Search reindexing. Add PR-specific checks for whatever
changed. Do not trigger externally visible provider actions without approval.

Show the evidence and intentional losses to the user and ask whether production is
done. Continue repairing until they explicitly say yes. Only then delete the recovery
package and end the maintenance window.
