# Recreate production CLI

This small recovery surface is designed to be driven by the
`.agents/skills/recreate-production` workflow, not as an unattended migration
system. It preserves exact stream offsets so encrypted secret events stay
valid, restores every selected project's secret and built-in integration
connection control facts, email sender policy, project security policy, active
global webhook routes, and rehydrates the config repo from GitHub. Historical
webhook/message traffic and the config-repo event journal are deliberately not
carried into the new deployment.

Run from `apps/os` inside the matching Doppler environment:

```bash
doppler run --config prd -- pnpm cli recreate-production export-projects \
  --projects iterate --breaking-change <PR> \
  --out /tmp/iterate-production-recovery.json

doppler run --config prd -- pnpm cli recreate-production preflight \
  --file /tmp/iterate-production-recovery.json

doppler run --config prd -- pnpm cli recreate-production restore \
  --file /tmp/iterate-production-recovery.json \
  --confirm 'RESTORE:<comma-separated-project-ids>'

doppler run --config prd -- pnpm cli recreate-production verify \
  --file /tmp/iterate-production-recovery.json
```

The package contains ciphertext and other connection metadata, never plaintext
secret material. It is written mode `0600`; keep it temporary and delete it
after the human confirms the cutover is finished.

This is an OS-only, one-shot maintenance-window tool. Its recovery RPC must be
deployed normally before a later breaking PR needs it. Auth-changing PRs need a
separate plan. `preflight` refuses provided integrations until the breaking PR
supplies an explicit rehydrator. Verification decrypts secret material in place
without returning it, compares built-in connection status/external IDs, checks
the active integration directory (including Slack routing), and boots the
GitHub-synced project worker.

This first version refuses any single restored stream above 8 MiB of serialized
JSON. That keeps the one-shot restore RPC bounded; if a project exceeds the
limit, stop before cutover and add staged restore rather
than weakening the guardrail.

Export performs a non-forced config-repo mirror push and fails unless GitHub
accepts the exact exported head. This proves the full config history has a
surviving authority before any destructive action.

Before restore, the operating agent must inspect the breaking PR against the
package's event shapes. The JSON is intentionally versioned and editable: when
the new code needs a mechanical payload conversion, transform a copy, rerun
`preflight`, show the change to the user, and only then restore it. If the
conversion is ambiguous, stop and ask.
