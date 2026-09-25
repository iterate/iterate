# Self-hosting Iterate

One Cloudflare Worker is the whole platform: the sign-in and consent pages, the OAuth server,
`/api`, `/mcp`, and the Durable Objects your projects live in. It deploys into your own Cloudflare
account; no domain is needed.

Setting it up is a recipe for your coding agent, [`public/setup-prompt.md`](public/setup-prompt.md),
served at https://os.iterate.com/setup-prompt.md. Tell Claude Code, Codex or opencode:

> follow https://os.iterate.com/setup-prompt.md to set up self-hosted iterate

From an empty folder it builds and deploys into the Cloudflare account you pick, creates your first
project, checks it, connects itself over MCP, and hands you the dash and voice links. Its
requirements are at the top: Workers Paid, R2, and access to Cloudflare Artifacts (a closed beta).
You can follow it by hand too.

The rest of this page is what the recipe leaves out.

## Project apps

`https://iterate.<your-subdomain>.workers.dev/projects/<project>/<routingSlug>/`, and `/projects/<project>/`
for the project's own config worker (`urls.ingressRouting: { type: "paths" }`).

With no domain, every project's code runs on the platform's own origin and can act as any
signed-in visitor, in every project that person can reach. Paths routing is for a deployment whose
people all trust each other. Apps are public unless their router marks a path private, exactly as
with a domain: a private path sends a visitor to the platform's sign-in and back. Signed file URLs
(`/projects/<project>/files/…`) work for anyone holding one, and are served sandboxed so a file
can never act as whoever opens it. An app must serve under its base path (Vite: `--base`); one that
only works at `/` does not work here.

For public apps, and apps on an origin of their own, give the deployment a
[custom domain](#custom-domain-own-origins-for-apps-and-tunnels).

## Other sign-in methods and configuration

The whole configuration is one JSON object, the `APP_CONFIG` secret (`apps/os/src/app-config.ts`
documents every key). Any key can also be set alone as a var, the path joined by `__`; the Vite build
sets `APP_CONFIG_URLS__INGRESS_ROUTING` and `APP_CONFIG_URLS__DASH` that way.

The recipe signs people in with one password (`login.password`). To add Google or Cloudflare
sign-in, or mailed codes, add `login.google`, `login.cloudflare` or `login.emailCode` to the
`APP_CONFIG` line in the `.secrets` file the recipe kept, and deploy again with `--secrets-file`.
Cloudflare takes `{ clientId, clientSecret }` from your own OAuth client; register
`<your-origin>/.auth/identity/cloudflare/callback` and configure the client for
`response_types: ["code", "id_token"]` and the `user-details.read` scope.

## Custom domain: own origins for apps and tunnels

With a domain, each project app gets an origin of its own, `<routingSlug>--<project>.<your-domain>`,
and the project's config worker answers at `<project>.<your-domain>`. The platform's sign-in stays
on `os.<your-domain>`, out of the apps' reach. Apps can be public, a dev server can serve at `/`,
and `iterate tunnel` works private or `--public`, at the root of its own origin.

What it takes:

1. **The zone** for `<your-domain>` on the same Cloudflare account as the Worker.
2. **A proxied wildcard DNS record** for `*.<your-domain>`. It also covers `os.<your-domain>`. The
   record's target does not matter; the Worker route answers. For iterate's own deployments
   `apps/os/scripts/ensure-resources.ts` creates it; on a self-host, add it in the dashboard.
3. **A certificate for `*.<your-domain>`.** Cloudflare's Universal SSL covers the apex and one
   wildcard level, which is why app hosts are one label (`<routingSlug>--<project>`) and not
   `<routingSlug>.<project>.<your-domain>`.
4. **Worker routes** `os.<your-domain>/*` and `*.<your-domain>/*` (zone `<your-domain>`), added to
   `selfHostWranglerConfig` in `apps/os/scripts/generate-wrangler-config.ts`, which sets none.
5. **The config:** `urls.os` = `https://os.<your-domain>` in `APP_CONFIG`, and
   `APP_CONFIG_URLS__INGRESS_ROUTING` = `{"type":"subdomains","hostname":"<your-domain>"}` in the
   same function's `vars`. That var overrides `urls.ingressRouting` in `APP_CONFIG`, and it is
   `{"type":"paths"}` there today.

Deploy again. `/mcp` then lives at `https://os.<your-domain>/mcp`; reconnect your MCP client there.
