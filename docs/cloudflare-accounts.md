# Cloudflare Accounts

Cloudflare credentials come from Doppler. Any command we run, whether it is a
script, an Alchemy deployment, a CLI call, or a one-off API request, runs in the
context of a Doppler config. That config determines which
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to use.

## Account Model

- `iterate (prd)` is the production Cloudflare account. It is used only through
  the base `prd` config.
- `dev/preview` is the shared non-production Cloudflare account. It is used for
  all local development and preview deployment concerns.
- Other accounts may be visible in tooling, especially the Cloudflare MCP
  server. For example, `garple` is a pretend customer account. Personal accounts
  should only be used when specifically requested.

Do not override Cloudflare credentials per project or per branch config. Doppler
should define them only in `_shared/dev`, `_shared/preview`, and `_shared/prd`;
app configs and branch configs inherit from those base configs.

## Deployments And Tools

Deployments use Alchemy v1. Run `alchemy.run.ts` through the target Doppler
config:

```bash
doppler run --project <app> --config <config> -- pnpm exec tsx ./alchemy.run.ts
```

The config decides whether that starts local dev, deploys a preview, or deploys
production.

For direct Cloudflare operations, use one of:

- the new Cloudflare CLI, run through Doppler, e.g.
  `doppler run --project <app> --config <config> -- cf ...`
- the Cloudflare MCP server, if the coding agent has been given access
- `wrangler` where it is still required, such as SSH into a running Cloudflare
  container
