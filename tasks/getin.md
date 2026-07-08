---
status: in-progress
size: small
branch: getin
---

# `pnpm getin` — one command to get into local OS

**Status summary**: spec written, implementation not started.

One dumb-ish wrapper so you never have to remember the minting recipe. `pnpm getin` from the repo root should end with a browser tab open on the local OS dashboard, signed in as a test identity, with an org and project that exist. It automates the exact recipe documented in `docs/dev-environments.md` ("Acting as users and admins" → the `--orgs`/`--projects` recipe).

## Behavior

`pnpm getin [flags]`, implemented as `scripts/getin.ts` (plain TypeScript per `docs/cli-scripts.md`), wired as `"getin": "tsx scripts/getin.ts"` in the root package.json.

Steps, in order:

1. **Doppler env**: if the forge/auth env (`AUTH_FORGE_PRIVATE_JWK`, `APP_CONFIG_ITERATE_AUTH__ISSUER`) is missing, re-exec itself under `doppler run --project os --config dev --`. `--config <name>` overrides the config (preview slots etc. left out of scope — this is a local-dev convenience).
2. **Dev server**: read `apps/os/.dev-server/dev-server.json` via `readDevServerInfo(appRoot, { requireLive: true })`. If no live server, run `pnpm dev start --detach` in `apps/os` and use the discovery info it returns.
3. **Get-or-create project**: shell out to the operator path from `apps/os`: `pnpm cli itx run --base-url <baseUrl> --eval '...'` — list projects, find one with the target slug, else `itx.projects.create({ slug })`. Default slug `test`. (itx has `projects.list()` / `projects.create({slug})` — see `apps/os/src/README.md`.)
4. **Org**: per the documented recipe, OS authorizes from claims, so the org claim can be deterministic/synthetic (`org_getin` / slug `getin`) unless the project row reports a real `organizationId`, in which case use that.
5. **Mint**: run `pnpm auth:mint --email <email> --orgs <json> --projects <json> --browser-url` (or import the same building blocks) to get the one-shot sign-in URL. Default email `test+test@nustom.com`.
6. **Open**: `open <url>` (darwin). `--print` prints the URL instead of opening — useful for agents and for piping to other browsers.

## Flags

- `--email <email>` — identity to mint (default `test+test@nustom.com`)
- `--slug <slug>` — project slug to get-or-create (default `test`)
- `--config <doppler config>` — default `dev`
- `--print` — print the sign-in URL instead of `open`ing it
- `--worktree <name>` / `-w [name]` — run `pnpm getin` in that worktree instead (matched by worktree directory name or path from `git worktree list`). Bare `-w` with no value prompts interactively: list all worktrees (including the main checkout), ordered by most recently touched (newest of HEAD commit time and worktree-root mtime), pick by number. Remaining flags pass through to the re-invocation.

## Checklist

- [ ] `scripts/getin.ts` with the flow above
- [ ] root package.json `getin` script
- [ ] `-w`/`--worktree` selection incl. interactive prompt ordered by most-recently-touched
- [ ] verify `pnpm getin -w` end-to-end — confirm pnpm doesn't swallow bare `-w` (it's pnpm's own `--workspace-root` alias; if it does swallow it, document `pnpm getin -- -w` or pick a different short flag)
- [ ] mention in `docs/dev-environments.md` next to the manual recipe

## Assumptions (made while Misha was AFK-ish)

- Local-dev only (dev Doppler config family); pointing at previews/prod stays with the manual `auth:mint` recipe.
- Fixed OTP test-email convention means `test+test@nustom.com` is safe and standard here.
- "Find the running dev process" = the existing `.dev-server/dev-server.json` discovery file with a liveness check, not process-table grepping.
- Re-running is idempotent: same email, same slug, same (or reused) org claim — `getin` twice should not create a second project.
