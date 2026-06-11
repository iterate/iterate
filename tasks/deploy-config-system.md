---
status: ready
size: medium
---

# Deploy-time config via the shared config system

Capture deploy-time config (what `alchemy.run.ts` consumes) with the same
`packages/shared/src/config.ts` engine that powers runtime config — typed zod
schema, JSON-blob + nested `__` overrides, `redacted()` wrappers — instead of
the ad-hoc `const AlchemyEnv = z.object({...})` parse over raw `process.env`
that every `alchemy.run.ts` hand-rolls today.

**Do this in a quiet window — it edits Doppler vars across apps/configs, which
changes deployed behaviour with no git diff.**

## The two configs

- **Runtime config** — bound into the worker, has the public/redacted browser
  split. Today `APP_CONFIG_*` / base key `APP_CONFIG`. ("App config" is a bad
  name; it's runtime config.)
- **Deploy config** (this task) — consumed only by the deploy script, never
  bound into the worker, **redacted-or-plain only** (no `publicValue`: there is
  no browser surface). Folds in _both_ our app-specific deploy inputs (worker
  routes, OAuth-client seed, captun gateway creds) _and_ the alchemy framework
  vars (`ALCHEMY_STAGE/PASSWORD/STATE_TOKEN`, `CLOUDFLARE_*`).

## Decisions (locked)

- **Prefix uses `__` as the boundary, not `_`:** `DEPLOY_CONFIG__CLOUDFLARE__API_TOKEN`
  → `["DEPLOY_CONFIG","CLOUDFLARE","API_TOKEN"]` → `cloudflare.apiToken`. The
  whole var is `__`-delimited path segments; peel the first as the namespace.
  Single underscores keep their current job (camelCase within a segment:
  `API_TOKEN` → `apiToken`). Base/JSON-blob key is `DEPLOY_CONFIG` (prefix minus
  trailing `__`). This kills the existing wart where the prefix/first-segment
  boundary is only resolvable because the prefix is a hardcoded constant.
- **Name is tool-neutral `DEPLOY_CONFIG`, not `ALCHEMY_CONFIG`.** The config
  pertains to "deploying this worker", which outlives the tool — if alchemy is
  ever swapped for wrangler the name must not lie and force a second re-key.
- **`redacted()` in deploy config means "don't print in deploy logs"** (the
  `console.dir(config)` in `alchemy.run.ts`, error traces), NOT "don't ship to
  browser" — deploy config is never bound into the worker. `publicValue` is
  meaningless here; the parser rejects it.
- **`DOPPLER_CONFIG` is not config content** — it's the ambient selector
  `doppler run` injects; we never define it. What we want is `stage`, a deploy
  field whose Doppler value is `${DOPPLER_CONFIG}` (same reference trick as
  today's `ALCHEMY_STAGE`). Flows in as `DEPLOY_CONFIG__STAGE`; `DOPPLER_CONFIG`
  itself stays a raw ambient var outside both schemas.
- **Single-sourcing rule for dual-purpose values:** a value is runtime config
  if the running worker needs it, deploy config only if the worker never does.
  The handful needed at both (e.g. `baseUrl` — deploy derives routes/DNS,
  runtime needs it) stay in runtime config and the deploy step reads them from
  there (as `iterate-app.ts` already does). Don't duplicate.

## Work

1. **Engine refactor (`packages/shared/src/config.ts`):** rename
   `compileRawAppConfigFromEnv` → `compileConfigFromEnv`, parameterize the
   prefix _separator_ (currently `_`, the nesting separator is already `__`).
   `getBaseConfigEnvKey` strips the configured separator. No change to JSON
   coercion, `__` nesting, `Redacted`, or `warnForUnknownConfigOverrideKeys`.
2. **`parseDeployConfigFromEnv` + `DeployConfig` base:** sibling of
   `parseAppConfigFromEnv`, prefix `DEPLOY_CONFIG__`, throws at schema-build
   time if it sees a `publicValue` field. `DeployConfig` base mirrors
   `BaseAppConfig` and carries `stage` + the alchemy/CF framework fields.
3. **Alchemy rehydrate bridge:** alchemy's internals read some vars straight
   off `process.env` (`alchemy()` → `ALCHEMY_PASSWORD`/`ALCHEMY_STAGE`;
   `createCloudflareApi({})` → `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`).
   So the deploy-config parse must be the first thing in `alchemy.run.ts` and
   write the canonical framework vars back to `process.env` before any alchemy
   call. One small adapter block per app until/unless alchemy grows an
   explicit-config API.
4. **Convert `apps/auth` as the reference app:** replace its `AlchemyEnv` with
   an `AuthDeployConfig` (workerRoutes: `string[]` not comma-split; cloudflare
   creds redacted; `seed.oauthClients` typed; betterAuthSecret/serviceAuthToken
   redacted; `stage` from `${DOPPLER_CONFIG}`). Re-key its Doppler deploy vars
   to `DEPLOY_CONFIG__*` across dev/dev_global/preview/preview_N/prd. Then do
   `os`, `tunnels`, `semaphore` and the shared `initAlchemy` parse.
5. **Captun deploy vars move in:** `CAPTUN_*` → `DEPLOY_CONFIG__CAPTUN__{...}`
   (the worker never reads them — textbook deploy config).

## Follow-up (separate PR, even quieter window)

Rename runtime config `APP_CONFIG_*` → **`CONFIG__*`** (`__` boundary, same fix
as above), including the `APP_CONFIG` _binding_ name in `IterateApp` /
`worker.ts`, the public-config extraction, types (`BaseAppConfig` →
`BaseRuntimeConfig`), and docs ("App Config" → "Runtime Config"). Biggest blast
radius (re-keys every Doppler var across os/auth/semaphore/tunnels ×
dev/preview/prd/dev\_<user>); do it with a script that diffs Doppler before/after
and verifies every var moved. Kept separate so the deploy-config win isn't
hostage to re-keying ~200 Doppler vars.

## Reference

- Engine: `packages/shared/src/config.ts` (`compileRawAppConfigFromEnv`,
  `redacted`, `publicValue`, `getBaseConfigEnvKey`, `ENV_PATH_SEPARATOR = "__"`).
- Hand-rolled deploy parses to replace: `apps/auth/alchemy.run.ts`,
  `apps/tunnels/alchemy.run.ts`, `apps/os/alchemy.run.ts`,
  `packages/shared/src/alchemy/init.ts` (`AlchemyEnv`).
- Doc to update: `docs/devops-cloudflare-doppler-alchemy-setup.md` (the "App
  Config And Deployment Config" section already names both concepts — make it
  describe the unified system).
