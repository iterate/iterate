---
name: recreate-production
description: "Owns a planned OS production recreation around a backwards-incompatible PR: captures selected projects before merge, gates main CI deployment, preserves Auth identities, manually deploys OS, restores secrets/integrations/config repos, verifies them, and waits for explicit human sign-off. Use when a user asks to reset, roll, resuscitate, or recreate production for a breaking change."
---

# Recreate production

Own the complete planned cutover. The input is the breaking PR. This is an
agent-operated workflow, not an unattended migration system.

Read [REFERENCE.md](REFERENCE.md) before running commands.

## Operating posture

- Consult the user at consequential forks unless they explicitly delegate them.
- Apply judgment from the PR and live evidence; do not blindly execute this checklist.
- Never let plaintext secret material enter chat or a file. Recovery events hold ciphertext.
- Preserve Auth D1 and the project-directory KV so restored projects keep exact IDs.
- This MVP is OS-only. If the breaking PR changes Auth code, Auth storage, or the OS/Auth identity
  contract, stop and make a separate plan with the user.
- Restore all secrets and all built-in integration connections for each selected project. A provided
  integration is a preflight blocker until the PR supplies an explicit rehydrator.
- Treat GitHub as the config repo's history authority and sync it inward without depth by default.
- Retain email sender policy and project egress/human-approval policy. Ordinary streams, schedules,
  files, workspaces, custom domains, derived state, and other Durable Objects are disposable.
- Run inside a one-person maintenance window. This MVP has no global write lock and assumes one-shot
  replacement; keep other operators and writes out until verification finishes.
- Do not declare success until automated smoke checks pass and the human explicitly says it is done.

## Workflow

1. Confirm the recovery plumbing from this skill is already deployed and tested in production. The
   preparatory PR that introduces it must deploy normally; do not put `skip-main-ci-deploy` on that PR.
   Then read the breaking PR, its full diff, deployment workflow, and current production shape. Stop
   for a separate plan if it touches Auth. Ask for the selected
   projects; suggest `iterate` plus Jonas/Misha personal projects only when they exist. Establish the
   cutover point and announce the maintenance window/write freeze.
2. Explain the proposed compatibility handling. Compare changed event/secret/integration schemas with
   the recovery package format. If conversion is needed, propose the exact transformation. If it is
   ambiguous or could invalidate ciphertext coordinates, stop and ask.
3. Ensure the `skip-main-ci-deploy` label exists and apply it to the PR before merge. Confirm the main
   workflow recognizes the label.
4. From the pre-merge production code, export the selected projects and run `preflight`. Keep the mode
   `0600` package in a temporary path. Record its path, project IDs, inventories, config GitHub repos,
   and restore confirmation. Export must prove GitHub accepts the exact config head. Do not proceed
   with an incomplete export or a rejected/non-fast-forward mirror.
5. Run the relevant pre-merge tests and inspect production health. Present a concise cutover plan and
   ask for approval immediately before the destructive step unless already authorized.
6. Merge the PR. Confirm the main workflow reached its gate and did not deploy Auth or OS. Check out
   the exact merged commit locally.
7. Erase OS production with `--preserve-auth`, then manually deploy OS from that exact commit. Auth is
   neither erased nor deployed. Treat any erase warning as a stop: inspect it and rerun until the
   command reports the intended resources gone. Watch deployment and production logs; pause on
   unexplained failures.
8. Run recovery `restore`. It rebuilds OS state under the exact Auth-preserved project IDs, replaces
   selected recovery streams, restores the integration directory, re-links each config repo, syncs
   all GitHub history inward, and verifies the inventories. Use `--replace-ready` only after proving
   a ready project is merely a fresh post-reset bootstrap.
9. Run `verify` again, then PR-specific smoke tests. The CLI must prove secret ciphertext decrypts in
   place without returning it, connection status/external IDs match, active global integration claims
   match (including Slack webhook routing), and the config GitHub link/head builds a usable worker.
   Also prove project routing/auth and AI Search reindexing. Use harmless provider probes; for Slack,
   verify the provider status and webhook route end to end without posting a message unless approved.
10. Show the user the evidence, intentional losses, warnings, and any manual repairs. Ask: “Does this
    production recreation look done to you?” Continue repairing until they explicitly say yes.
11. Only after that yes: delete the temporary package, record the outcome, and report completion.

If interrupted, do not improvise around a half-restored deployment. Keep the maintenance window closed,
inspect evidence, and normally rerun the complete one-shot restore with the explicit ready-project
override after confirming the targets are only this cutover's partial/fresh state. Auth preservation and
the recovery package are the safety anchors; never erase both.
