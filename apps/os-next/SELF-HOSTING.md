# Self-hosting iterate OS

One Cloudflare Worker is the whole platform: the sign-in and consent pages, the OAuth server,
`/api`, `/mcp`, and the Durable Objects your projects live in. It deploys into your own Cloudflare
account with `wrangler deploy` and two secrets. No domain is needed; a **Workers Paid** plan is
(the Worker declares paid-plan limits and binds Browser Run and the Worker Loader).

```bash
git clone https://github.com/iterate/iterate && cd iterate
pnpm install
pnpm --filter os-next build                 # writes apps/os-next/wrangler.self-host.jsonc
npx wrangler login                          # opens the browser; pick the account to deploy into

# The two secrets: APP_CONFIG holds the sign-in password (choose one), the key encrypts your
# projects' secrets at rest. Keep the key somewhere safe: losing it loses that material.
cat > .secrets <<EOF
APP_CONFIG={"login":{"password":"choose-a-password"}}
APP_CONFIG_SECRETS__KEY=$(openssl rand -hex 32)
EOF
npx wrangler deploy --config apps/os-next/wrangler.self-host.jsonc --secrets-file .secrets
rm .secrets
```

The first deploy creates the D1 database, the two KV namespaces and the R2 bucket by name in your
account and prints the Worker's URL, `https://iterate.<your-subdomain>.workers.dev`. Everything
below is on that origin.

## Using it

- **Sign in:** open the URL. Enter any email and the password you chose. Anyone who knows the
  password can sign in as the email they type, so the password is the membership and the email is
  the name tag — hand it to the people who should be in. The first sign-in creates an organization
  and a project on the consent page.
- **MCP:** `https://iterate.<your-subdomain>.workers.dev/mcp` — add it to Claude, Codex or Cursor as
  a remote MCP server; it signs in through the same page and exposes one tool, `run`.
- **The dash:** projects, organizations, sessions and personal access tokens live at
  https://dash.iterate2.com, an app we host that connects to any iterate platform: your platform's
  landing page links to its connect page, which names your platform's host and asks before binding
  the browser to it (a plain link never signs you in anywhere). The dash then shows
  "Connected to <your host>".
- **Project apps:** `https://iterate.<your-subdomain>.workers.dev/projects/<project>/<app>/`, and
  `/projects/<project>/` for the project's own config worker (`urls.ingressRouting: { type: "paths" }`).
  Every document served there runs sandboxed in the browser (an opaque origin: no cookies, no
  storage), so an app that needs the person's identity authenticates in-band rather than by cookie.

## Configuration

The whole configuration is one JSON object, the `APP_CONFIG` secret (`apps/os-next/src/app-config.ts`
documents every key). Any key can also be set alone as a var, the path joined by `__`; the generated
config sets `APP_CONFIG_URLS__INGRESS_ROUTING` and `APP_CONFIG_URLS__DASH` that way. To add Google
sign-in or mailed codes later, put `login.google` or `login.emailCode` in the object and deploy again.

```bash
printf 'APP_CONFIG=%s\n' '{"login":{"password":"…","google":{"clientId":"…","clientSecret":"…"}}}' > .secrets
npx wrangler deploy --config apps/os-next/wrangler.self-host.jsonc --secrets-file .secrets && rm .secrets
```

## Updating

```bash
git pull
pnpm install
pnpm --filter os-next build
npx wrangler deploy --config apps/os-next/wrangler.self-host.jsonc
```

A deploy without `--secrets-file` keeps the secrets already on the Worker. The directory schema is
applied by the Worker itself at boot, so there is no migration step.

## Custom domain (optional)

Add your zone to the same Cloudflare account, then set `urls.os` to `https://os.<your-domain>` and
`urls.ingressRouting` to `{"type":"subdomains","hostname":"<your-domain>"}` in `APP_CONFIG`, and add
a route for `os.<your-domain>/*` and a wildcard route `*.<your-domain>/*` (with a proxied wildcard
DNS record) to the config. Projects then answer at `<app>--<project>.<your-domain>` and
`<project>.<your-domain>`.
