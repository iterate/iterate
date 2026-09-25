# Self-hosting Iterate

One Cloudflare Worker is the whole platform: the sign-in and consent pages, the OAuth server,
`/api`, `/mcp`, and the Durable Objects your projects live in. It deploys into your own Cloudflare
account; no domain is needed.

Setting it up is a recipe for your coding agent, [`public/setup-prompt.md`](public/setup-prompt.md),
served at https://os.iterate.com/setup-prompt.md. Tell Claude Code, Codex or opencode:

> follow https://os.iterate.com/setup-prompt.md to set up self-hosted iterate

From an empty folder it builds and deploys into the Cloudflare account you pick, creates your first
project, checks it, connects itself over MCP, and hands you the dash, voice and kit links. Its
requirements are at the top: Workers Paid, R2, and access to Cloudflare Artifacts (a closed beta).
You can follow it by hand too.

The rest of this page is what the recipe leaves out.

## Project apps

`https://iterate.<your-subdomain>.workers.dev/projects/<project>/<routingSlug>/`, and `/projects/<project>/`
for the project's own config worker (`urls.ingressRouting: { type: "paths" }`).

With no domain, every project's code runs on the platform's own origin. An app's code can do
anything the person visiting it can do on the deployment, in every project they reach, including
minting tokens that outlive the visit. Paths routing is for a deployment whose people all trust each
other. Apps are public unless their router marks a path private, exactly as with a domain: a private
path sends a visitor to the platform's sign-in and back. Signed file URLs
(`/projects/<project>/files/…`) work for anyone holding one, and are served sandboxed so a file
can never act as whoever opens it.

For apps on an origin of their own, or people who don't all trust each other, give the deployment
a [custom domain](#custom-domain-own-origins-for-apps-and-tunnels).

## Other sign-in methods and configuration

The whole configuration is one JSON object, the `APP_CONFIG` secret (`apps/os/src/app-config.ts`
documents every key). Any key can also be set alone as a var, the path joined by `__`; the Vite build
sets `APP_CONFIG_URLS__INGRESS_ROUTING` and `APP_CONFIG_URLS__DASH` that way.

The recipe signs people in with one password (`login.password`). To add Google, Cloudflare or
GitHub sign-in, or mailed codes, add `login.google`, `login.cloudflare`, `login.github` or
`login.emailCode` to the `APP_CONFIG` line in the `.secrets` file the recipe kept, and deploy again
with `--secrets-file`. A provider's sign-in is `{}` (or `{ scopes }`) and signs in with that
provider's integration client, which the person's connection then uses too:
`integrations.cloudflare` takes `{ oauthClientId, oauthClientSecret }` from your own OAuth client;
register `<your-origin>/.auth/identity/cloudflare/callback` and
`<your-origin>/api/integrations/cloudflare/callback`, and configure the client for
`response_types: ["code", "id_token"]` and the `user-details.read` scope.

## Integrations

A self-host has none of iterate's apps, so the Dash's Integrations page offers Slack, Google and
GitHub only through **Use your own app**, once per project connection. The sheet shows the URLs to
paste into the provider's console, then keeps the credentials you paste into it in the project's
secret `/secrets/<provider>-<connection>`:

- **Slack**: an app at api.slack.com/apps. The redirect URL
  (`<origin>/api/integrations/slack/callback`) goes under OAuth & Permissions, the webhook URL
  (`<origin>/api/integrations/slack/webhook/<projectId>/<connection>`) under Event Subscriptions
  once connected, and the interactivity URL
  (`<origin>/api/integrations/slack/interactivity-webhook/<projectId>/<connection>`) under
  Interactivity & Shortcuts. Paste the client ID, client secret and signing secret.
- **Google**: an OAuth client (Web application) in Google Cloud Console, with
  `<origin>/api/integrations/google/callback` as an authorized redirect URI. Paste the client ID and
  secret.
- **GitHub**: a GitHub App whose Callback URL is `<origin>/api/integrations/github/callback`, with
  "Request user authorization (OAuth) during installation" ticked, and whose webhook URL is
  `<origin>/api/integrations/github/webhook/<projectId>/<connection>`. Paste the App ID, slug,
  client ID, client secret, private key (.pem) and webhook secret.

Connecting Cloudflare, a person's own Google or Cloudflare connection, and signing in with Google,
Cloudflare or GitHub all need that provider's app in `APP_CONFIG` as `integrations.<provider>` (the
keys are in `src/app-config.ts`). Register its redirect URIs: `<origin>/.auth/identity/callback`
(Google), `<origin>/.auth/identity/cloudflare/callback` (Cloudflare) or
`<origin>/.auth/identity/github/callback` (GitHub) for sign-in, and
`<origin>/api/integrations/<provider>/callback` for connecting. The Dash shows a provider's
one-click connect only when the deployment has its app.

## Custom domain: own origins for apps and tunnels

With a domain, each project app gets an origin of its own, `<routingSlug>--<project>.<your-domain>`,
and the project's config worker answers at `<project>.<your-domain>`. The platform's sign-in stays
on `os.<your-domain>`, out of the apps' reach. Apps can be public, a dev server can serve at `/`,
and `iterate tunnel` works private or `--public`, at the root of its own origin.

What it takes:

1. **The zone** for `<your-domain>` on the same Cloudflare account as the Worker.
2. **A proxied wildcard DNS record** for `*.<your-domain>`. It also covers `os.<your-domain>`. The
   record's target does not matter; the Worker route answers.
3. **A certificate for `*.<your-domain>`.** Cloudflare's Universal SSL covers the apex and one
   wildcard level, which is why app hosts are one label (`<routingSlug>--<project>`) and not
   `<routingSlug>.<project>.<your-domain>`.
4. **Worker routes** `os.<your-domain>/*` and `*.<your-domain>/*` (zone `<your-domain>`), added to
   `selfHostWranglerConfig` in `apps/os/scripts/generate-wrangler-config.ts`, which sets none.
5. **The config:** `urls.os` = `https://os.<your-domain>` in `APP_CONFIG`, and
   `APP_CONFIG_URLS__INGRESS_ROUTING` = `{"type":"subdomains","hostname":"<your-domain>"}` in the
   same function's `vars`, which override `urls.ingressRouting` in `APP_CONFIG`.

Deploy again. `/mcp` then lives at `https://os.<your-domain>/mcp`; reconnect your MCP client there.
