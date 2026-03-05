# Stage

Stage is an **input**, not something derived. The deployer decides what stage to deploy to.

## What stage means

Stage determines the URL namespace and identity of a deployment:

| Stage           | URL                          |
| --------------- | ---------------------------- |
| `prd`           | os.iterate.com               |
| `stg`           | os-stg.iterate.com           |
| `preview-alpha` | os-preview-alpha.iterate.com |
| `dev-jonas`     | os-dev-jonas.iterate.com     |

That's it. Stage is just "which URL". Everything else—secrets, database, OAuth clients, Slack tokens—are separate concerns configured via environment variables.

## URL derivation

Stage maps to URL via simple transformation:

```ts
const subdomain = `os-${stage}`.replace(/^os-prd$/, "os");
const url = `${subdomain}.iterate.com`;
```

For `apps/iterate-com`, replace `os` with `www`.

## Usage

```bash
# Deploy to a stage
pnpm deploy --stage preview-alpha

# Local dev with your stage
pnpm dev --stage dev-jonas
```

## Principles

### Stage is not environment

We don't use "environment" as a concept. There's no `ENV=production` or `ENVIRONMENT=staging`. Just stage.

### Avoid NODE_ENV

`NODE_ENV` is not informative. On Cloudflare Workers, it's always `"production"` even for staging deployments. We only use it for:

- Dev server detection (vite vs built)
- Test framework detection (vitest sets it)

Never check `NODE_ENV` for business logic.

### Avoid conditional logic on stage

Bad:

```typescript
if (process.env.STAGE === "prd") {
  // production-specific behavior
}
```

Good:

```typescript
if (process.env.ENABLE_DEBUG_LOGGING === "true") {
  // explicitly configured behavior
}
```

Stage checks leak assumptions about what stages exist and what they mean. Explicit env vars are clearer and more flexible.

**Allowed exceptions**: Tagging analytics/logs with stage for observability (e.g., PostHog `$environment` property).

### Local is a separate axis

"Local" (running from source with hot reload) is independent from stage:

|                   | Local                  | Deployed                |
| ----------------- | ---------------------- | ----------------------- |
| **What it means** | `vite dev`, hot reload | Built app on Cloudflare |
| **How to check**  | `app.local` (alchemy)  | `!app.local`            |

You could run local against any stage's config. They're orthogonal.

## Secrets & Doppler

Secrets come from Doppler configs. While stage and secrets are conceptually independent, we enforce a safety check: deploying to `prd` stage requires `prd` doppler config.

### Branch configs

Use Doppler branch configs for isolation:

| Config pattern    | Purpose                              |
| ----------------- | ------------------------------------ |
| `dev`             | Base dev config (don't use directly) |
| `dev_jonas`       | Engineer-specific dev config         |
| `dev_rahul`       | Engineer-specific dev config         |
| `stg`             | Base staging config                  |
| `preview_alpha`   | Preview environment A                |
| `preview_bravo`   | Preview environment B                |
| `preview_charlie` | Preview environment C                |
| `prd`             | Production                           |

Engineers should use `dev_{name}` configs. Preview environments use `preview_alpha`, `preview_bravo`, etc. (not numbered—implies no ordering).

**Never use `dev_personal`**. It's a Doppler built-in that makes it impossible for others to fix secrets. We've banned it.

### Stage to config mapping

```
prd stage → requires prd doppler config
stg stage → requires stg doppler config
preview-* stages → requires preview_* doppler config
dev-* stages → requires dev_* doppler config
```

Bypass with `SKIP_DOPPLER_CHECK=true` if you know what you're doing.

## Database

Database connection is an input, not derived from stage:

```bash
DATABASE_URL=postgres://...   # connection string
DATABASE_BRANCH=pr-1234       # optional, for planetscale branching
```

### Safety checks

Like doppler, we validate DB config to prevent accidents:

| Stage       | Allowed DB         | Branch allowed? |
| ----------- | ------------------ | --------------- |
| `prd`       | production DB only | No              |
| `stg`       | staging DB only    | No              |
| `preview-*` | dev DB only        | Yes             |
| `dev-*`     | dev DB only        | Yes             |

Non-prd stages **fail** if `DATABASE_URL` points to production. Bypass with `SKIP_DB_SAFETY_CHECK=true`.

### Preview environments

CI sets up isolated branches automatically:

```bash
DATABASE_URL=<dev-db-connection>
DATABASE_BRANCH=preview-alpha  # isolated branch per preview env
```

Each preview env gets its own branch of the dev database—isolated from other preview envs but sharing the dev DB infrastructure.

### Debugging with different DBs

To point local dev at staging DB (e.g., to debug an issue):

```bash
SKIP_DB_SAFETY_CHECK=true DATABASE_URL=<staging-url> pnpm dev
```

Explicit override required—you can't do this accidentally.

## Why this model?

This is [12-factor](https://12factor.net/config) thinking:

1. **Portability** - Same code runs in any stage. Behavior differences come from config, not code branches.
2. **Clarity** - When you see `ENABLE_FEATURE_X=true`, you know exactly what it does. When you see `STAGE=prd`, you only know the URL.
3. **Flexibility** - Easy to add new stages (PR previews, team-specific deploys) without code changes.
4. **Safety** - Explicit config is harder to misconfigure than implicit stage-based behavior.
