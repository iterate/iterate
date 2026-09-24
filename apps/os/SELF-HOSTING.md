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
for the project's own config worker (`urls.ingressRouting: { type: "paths" }`). Every document
served there runs sandboxed in the browser (an opaque origin: no cookies, no storage), so an app
that needs the person's identity authenticates in-band rather than by cookie.

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

## Custom domain (optional)

Add your zone to the same Cloudflare account, then set `urls.os` to `https://os.<your-domain>` and
`urls.ingressRouting` to `{"type":"subdomains","hostname":"<your-domain>"}` in `APP_CONFIG`, and add
a route for `os.<your-domain>/*` and a wildcard route `*.<your-domain>/*` in
`selfHostWranglerConfig` in `apps/os/scripts/generate-wrangler-config.ts` (with a proxied wildcard
DNS record) to the config. Projects then answer at `<routingSlug>--<project>.<your-domain>` and
`<project>.<your-domain>`.
