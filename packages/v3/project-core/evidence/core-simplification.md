# Internal simplification — 5 September 2026

The historical stricter all-authored count was **5,435**, down from **5,497**;
it included E2E alongside implementation. The hard **<5,000** requirement now
applies to implementation only: runtime source, UI, configuration, package
metadata and scripts. `e2e/` remains counted and printed separately because its
public-network coverage is required but is not shipped implementation. Notes,
evidence and generated local state are outside both figures. No test cases,
public methods, storage tables, guardrails or UI controls were removed, and no
runtime code moved out of the counted package.

## Changes behind the existing interface

- Lending: malformed pager frames now share their log/close/dispose path.
  The JSON wire format is unchanged, including for existing socket sessions.
- Processors: single-statement writes use SQLite's atomic statements directly;
  newly inserted progress is returned by `INSERT ... RETURNING`. The existing
  read-only progress fast path stays intact. Superseded or disabled rows are
  removed with one conditional SQL statement against committed settings.
  Multi-write stream and approval transactions remain explicit.
- Signatures: asynchronous verification returns only verified, distinct signer
  identities. The commit transaction alone assigns trust flags and level using
  current policy. Public envelopes, signing bytes, stored receipts, plural
  signatures and same-batch trust rotation are unchanged.
- E2Es: exact API envelopes and expected HTTP faults use their existing shared
  assertions. Processor recovery now also asserts that superseded state is
  gone and setting the processor to `null` leaves no active progress row.

The signature seam now says exactly what it establishes:

```ts
const signerKeyIds = await verifyEvent(contextName, input);
// Later, within the atomic append transaction:
const signers = signerKeyIds.map((keyId) => ({
  keyId,
  trusted: trust.keys.includes(keyId),
}));
```

The processor cleanup operates on the existing schema, with no data migration:

```sql
DELETE FROM processor_progress WHERE NOT EXISTS (
  SELECT 1 FROM settings
  WHERE key = 'processor/' || processor_progress.name
    AND offset = processor_progress.setting_offset
    AND value != 'null'
);
```

Only Stream writes these settings and validates their processor configuration
before commit. Execution still parses each active configuration at its use site.

## Verification

```sh
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  pnpm --dir packages/v3/project-core test
pnpm --dir packages/v3/project-core typecheck
pnpm exec oxlint packages/v3/project-core --threads 1 --deny-warnings
pnpm exec oxfmt --check packages/v3/project-core
pnpm --dir packages/v3/project-core size
```

Final full local run: **41 passed, zero failed/skipped/cancelled**, total
**23,195.777 ms**. Typecheck, lint (zero warnings/errors) and formatting pass.
The former size command correctly exited 1 at the historical 5,435 all-authored
lines. The current command enforces implementation alone and prints E2E and
historical all-authored totals beside it. These implementation changes have not
been deployed; the core preview remains version
`5b14ebe0-f704-4426-9c19-8fc97275a791`. Its unresolved native WebSocket outcomes
and historical remote test failures remain recorded in [preview.md](preview.md).
