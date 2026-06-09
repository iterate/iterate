---
state: open
priority: medium
size: large
dependsOn: []
---

# Dead code, stale workspace config, and agent-docs cleanup

Inventory from a repo-wide audit (explore subagents + manual verification on `apps/os` worktree, May 2026). Use this as a grab-bag cleanup task; split into smaller PRs if needed.

## Verification notes

- Live OS app in this tree: **`apps/os`** (not `apps/os2`). Root `AGENTS.md` pointers to `apps/os`, `apps/os/AGENTS.md`, and `docs/devops-cloudflare-doppler-alchemy-setup.md` are valid here.
- Run **`pnpm knip`** for a fuller unused-export pass beyond static grep.
- Do not delete Worker bindings, wrangler routes, or CLI entrypoints without checking alchemy/wrangler/package scripts.

---

## High confidence — remove or wire up

### Stale `pnpm-workspace.yaml` entries

Listed explicitly but **missing on disk**:

- `apps/cli`
- `apps/fetch-test`
- `apps/example-3`
- `apps/example-v2`
- `apps/example-v2-contract`
- `services/*` (no `services/` directory)

Also check root `package.json` script `"cli": "cd apps/cli && ..."` — broken if `apps/cli` is gone.

### Unused `packages/shared` exports

| Module                      | Evidence                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-agent-path`         | `buildDefaultGitHubPrAgentPath`, `normalizeAgentPath`, etc. only in `packages/shared/src/github-agent-path.ts`. No `@iterate-com/shared/github-agent-path` imports. |
| `jsonata-reactor` processor | Contract + implementation exported; only `jsonata-transformer` appears to be wired into current processor docs.                                                     |

Either delete or register `jsonata-reactor` like `jsonata-transformer`.

### Root dependency with no code usage

- **`emittery`** — root `package.json` / lockfile only; zero `.ts`/`.tsx` imports.

### Workspace packages with no in-repo consumers

| Package                     | Notes                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@iterate-com/auth-example` | Sample app; nothing depends on it; not in `.github` workflows.                                               |
| `pidnap`                    | No `workspace:*` dependents; duplicate `"name": "pidnap"` in `packages/pidnap` and `packages/pidnap/docker`. |

Decide: keep as documented samples/tooling, or remove from workspace.

### Broken doc path

- `packages/iterate/README.md` says `apps/os/backend/orpc/root.ts` — actual path: **`apps/os/src/orpc/root.ts`**.

---

## Medium confidence — gaps and drift

### `iterate` CLI excluded from recursive CI

Root scripts: `--filter '!iterate'` on `build`, `typecheck`, `test`. CI runs those at root → **`packages/iterate` not typechecked/tested in CI**. Confirm intentional vs gap.

### Cloudflare preview path filters

`.github/workflows/cloudflare-previews.yml` (and ts-workflows source) omit paths that exist:

- `apps/auth/**`, `apps/auth-contract/**`
- `apps/iterate-com/**`
- `apps/auth-example/**`
- `packages/ui/**`, `packages/mock-http-proxy/**`

PRs touching only those areas may skip previews.

### Developer-only root scripts (not in CI)

Examples: `knip`, `skills:sync`, `super-reset`, `preview`, `workflows` — OK if intentional; not validated in CI.

## AGENTS.md / docs — redundancy and confusion

### Duplicate root agent files

- **`AGENTS.md` ≡ `CLAUDE.md`** (byte-identical). Single source + pointer, or sync automation.

### Overlap with `docs/design-system.md`

Repeats layout rules already in AGENTS (no `h1`, `HeaderActions`, card list Tailwind recipes). Repo meta-guidance: prefer durable facts over exact class strings that go stale.

### Parallel e2e agent docs

- `apps/os/e2e/AGENTS.md` (~38 lines)

Consider one canonical e2e/fixture doc (e.g. extend `docs/vitest-patterns.md`) + one-line pointers per app.

### Drizzle skill vs OS sqlfu

- `.agents/skills/drizzle-migrations/SKILL.md` correctly says **not** for `apps/os` (sqlfu/D1).
- Root `AGENTS.md` pointers link drizzle skill for “schema changes” without that caveat on the pointer line — agents may apply wrong workflow on OS.

### Triplicate skills directories

Same skills copied under `.agents/skills/`, `.claude/skills/`, `.cursor/skills/`, `.codex/skills/` (e.g. `agent-browser`, `code-review`, `drizzle-migrations`, `debug-os-worker`). Maintenance surface; consider one canonical tree + sync script (`skills:sync` exists but is not CI-gated).

---

## Suggested cleanup order

1. **Config hygiene** — prune `pnpm-workspace.yaml`; fix/remove root `"cli"` script.
2. **Dead shared code** — `github-agent-path`, `jsonata-reactor` (delete or wire).
3. **Root deps** — remove `emittery` if unused.
4. **Samples** — document or remove `auth-example`, `pidnap`.
5. **Docs** — dedupe AGENTS/CLAUDE; fix iterate README path; trim design-system overlap; clarify drizzle vs sqlfu in AGENTS pointers.
6. **CI/previews** — extend preview path list; decide on `iterate` in typecheck/test.
7. **`pnpm knip`** — run and fold results into this task or follow-ups.

---

## Subagent references (optional follow-up)

- Dead code exploration: `b0ece27b-d5c4-4aed-96b7-7956954cc87e`
- AGENTS/docs audit: `91c2d6b3-b25a-482f-ab11-69587037a876`
- Workspace/CI: `14437f53-4318-43c8-a397-1d354fb5e795`
