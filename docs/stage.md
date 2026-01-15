# Stage

Stage is an **input**, not something derived. The deployer decides what stage to deploy to.

## What stage means

Stage determines the URL namespace and identity of a deployment:

| Stage     | URL                    |
| --------- | ---------------------- |
| `prd`     | os.iterate.com         |
| `stg`     | os-staging.iterate.com |
| `misha`   | os-misha.iterate.com   |
| `pr-1234` | os-pr-1234.iterate.com |

That's it. Stage is just "which URL". Everything else—secrets, database, OAuth clients, Slack tokens—are separate concerns configured via environment variables.

## Usage

```bash
# Deploy to a stage
pnpm deploy --stage misha

# Stage defaults to dev-$ITERATE_USER for local dev
pnpm dev  # implicitly --stage dev-jonas
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

Secrets come from Doppler configs: `dev`, `stg`, `prd`.

While stage and secrets are conceptually independent, we enforce a safety check: deploying to `prd` stage requires `prd` doppler config. This prevents accidentally deploying production with dev secrets.

```
prd stage → requires prd doppler config
stg stage → requires stg doppler config
dev-* / pr-* stages → requires dev doppler config
```

Bypass with `SKIP_DOPPLER_CHECK=true` if you know what you're doing.

## Why this model?

This is [12-factor](https://12factor.net/config) thinking:

1. **Portability** - Same code runs in any stage. Behavior differences come from config, not code branches.
2. **Clarity** - When you see `ENABLE_FEATURE_X=true`, you know exactly what it does. When you see `STAGE=prd`, you only know the URL.
3. **Flexibility** - Easy to add new stages (PR previews, team-specific deploys) without code changes.
4. **Safety** - Explicit config is harder to misconfigure than implicit stage-based behavior.
