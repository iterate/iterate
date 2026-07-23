---
status: complete
size: medium
---

# Steal a GitHub installation after confirmation

## Status

Done. The signed confirmation flow, authenticated RPC, atomic claim move, old-connection cleanup,
dialog, docs, generated API, full local checks, headed preview proof, and green preview rerun are
complete. No review threads remain.

## Goal

When a GitHub App installation is already connected to another Iterate project, let an authorized
user move it to the current project after an explicit “are you sure?” confirmation, matching the
existing Telegram steal experience.

## Decisions and assumptions

- A GitHub installation can belong to one Iterate project at a time because its webhooks have one
  routing destination.
- The existing GitHub user OAuth check remains the authorization proof. A browser-supplied
  installation ID is never enough to steal a connection.
- After GitHub proves the user can access the installation, a conflicting callback mints a
  short-lived signed confirmation state bound to the installation, target project, and user.
- The callback redirects to the integrations page with the normal
  `github_installation_already_claimed` error plus the signed confirmation state. The page opens an
  `AlertDialog`; cancel clears both query parameters.
- Confirmation is a dedicated project RPC. It accepts only the signed state and derives the
  confirming user from the authenticated itx principal; callers cannot supply the user identity.
- Prepare the new project connection before routing moves. Commit the old unclaim and new claim in
  one directory append, then brick the old secret and append a disconnected fact with reason
  `stolen-by-another-project`.
- Do not name the old project in the result or dialog. It may belong to another organization.
- Replaying a successfully used confirmation state is idempotent when the installation is already
  owned by the target project.
- If the old project releases the installation before confirmation, confirmation connects it as a
  normal unclaimed installation.

## Checklist

- [x] Return a signed GitHub steal-confirmation state only after successful GitHub user OAuth proof.
      *The callback mints a short-lived `githubInstallationAuthorized` state after GitHub enumerates
      the installation for the signed-in user.*
- [x] Add an authenticated `confirmGithubSteal({ state })` project RPC that validates the signed
      project/user/installation proof. *`ProjectIntegrationsRpcTarget` derives the user from its
      authenticated principal.*
- [x] Move the directory claim atomically, prepare the new connection first, and dispossess the old
      project afterward without leaking its identity. *`confirmGithubSteal` batches the unclaim and
      claim, then records `stolen-by-another-project` on the old journal.*
- [x] Make confirmation replay safe and handle a claim released between prompt and confirmation.
      *Focused tests cover both outcomes.*
- [x] Show an accessible destructive confirmation dialog on the integrations page; cancel clears
      the error/state and confirm connects without repeating OAuth. *Headed preview-5 verification
      exercised both buttons and captured the dialog for the PR.*
- [x] Add focused red-green tests for conflict proof, authorization checks, transfer side effects,
      replay, and released-claim behavior. *Nine GitHub connect tests pass.*
- [x] Update the GitHub integration docs and generated public itx API artifacts.
      *The design doc describes OAuth proof and claim moves; both generated itx API copies and the
      graph include `confirmGithubSteal`.*
- [x] Run focused tests and repository pre-PR checks; verify the flow in a headed browser on a
      preview deployment and add visual proof to the PR. *All local workspace checks pass; preview-5
      connected and removed a synthetic installation through the deployed UI/RPC, and the PR body
      includes the screenshot.*
- [x] Move this task to `tasks/complete/` and update the PR body when implementation and review are
      complete. *The dated completion file and PR body include the final verification evidence.*

## Implementation log

- 2026-07-23: Production diagnosis found installation `114628444` live on `task-demo`; the current
  callback correctly rejected connecting it to `misha`. That concrete case defines the acceptance
  flow for this task.
- 2026-07-23: Added the signed proof, explicit RPC, safe transfer ordering, dashboard dialog, and
  focused regression coverage. Focused tests and the OS typecheck pass.
- 2026-07-23: Full workspace tests, typecheck, lint, and formatting pass. Headed preview-5 testing
  proved cancel and confirm; the synthetic connection was disconnected afterward. The first
  preview CI run hit an unrelated existing stream-wait flake, so an exact rerun is in progress.
- 2026-07-23: The exact preview rerun passed all five deployed apps. The PR has no unresolved
  review threads and its body includes the final screenshot and verification summary.
