# Credentials

The platform accepts three kinds of bearer. Each has its own job.

| Credential                                               | Who holds it                                                                            | Works at                                                      | Lifetime                                                        | Ended by                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| **Personal access token** (`itk_…`)                      | a person, for scripts, MCP clients, devices                                             | `/api`, `/mcp`, and the hosts of the projects it covers       | until its expiry, or none                                       | revoking it (Dash Sessions, `iterate tokens revoke`) |
| **OAuth access token**                                   | an app a person signed in to: the Dash, the CLI, an MCP client that did the OAuth dance | its one resource: `/api` (with the projects' hosts) or `/mcp` | an hour; its grant refreshes for a week unused, 30 days at most | signing out, or ending the session in the Dash       |
| **Operator bearer** (`APP_CONFIG` `secrets.adminBearer`) | the deployment, for automation                                                          | `/api` only                                                   | until the secret is rotated                                     | rotating the secret                                  |

## OAuth tokens

`apps/os` is an OAuth authorization server (`src/oauth.ts`, on `@cloudflare/workers-oauth-provider`
1.0). It protects two **resources**, which are just the two URLs it serves APIs on: `/api` (Cap'n
Web, for the apps and the CLI) and `/mcp` (in production `https://mcp.iterate.com`). An app asks
for access to one of them, the person consents, and the app gets a token whose audience is that
one resource ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). The MCP specification requires
it: an MCP server accepts only tokens issued for itself, so a token for another API can't be
replayed against it. That is why an OAuth token for `/api` is refused at `/mcp`, and the reverse.
The two resources are not project-specific: a grant's projects are what the person ticked at
consent.

## Personal access tokens

A personal access token is iterate's own API key, the kind a SaaS product lets you make in its
settings. You make one and paste it wherever you need it: an MCP client, `curl`, a script, a
device. It is not an OAuth token, so it has no single audience, and one key works at `/api`,
`/mcp` and your projects' hosts.

- **What it can do.** It acts as you, with the `iterate` scope, on the projects you chose when you
  made it. It can't see or manage your sessions or keys, and it can't create organizations, so a
  leaked key can't mint another.
- **Format.** `itk_<your user id>_<key id>_<256 random bits><CRC32>`, 103 characters
  (`src/personal-access-token.ts`). The fixed prefix and checksum make a leaked key easy to find:
  `\bitk_[0-9a-f]{32}_[0-9a-f]{16}_[0-9A-Za-z]{49}\b` is a pattern for secret scanning.
- **Storage.** The key is shown once, and never recorded: the Dash shows it in a block PostHog's
  session replay and autocapture leave out (`NotRecorded`, `packages/ui`). Your account keeps its
  SHA-256, never the key (the account's `personalAccessTokens`, folded from
  `account/personal-access-token-minted`, which also names the session that minted it). No log
  line carries a key.
- **Admission.** A key proves itself before any Durable Object is dialled. The format and the
  checksum are public, and user ids are not secret, so anyone can write a well-formed key under
  anyone's id. So the platform first looks the key's SHA-256 up in KV (`OAUTH_KV`, an index the
  mint writes and revocation deletes), as the OAuth library looks up an access token it issued. A
  miss is refused on that one read. Only a hit reads your account, the truth of the key: its hash,
  compared in constant time, its end and its expiry.
- **Revocation.** Revoking lands `account/grant-ended` on your account before the call returns,
  then deletes the key's index entry. From then on `/api`, `/mcp` and the project hosts refuse the
  key. What it holds open closes at its next re-check, within 30 seconds of when it opened and at
  most a minute: a socket on `/api` (`src/rpc.ts`), and a WebSocket or a streamed body (one with
  no `content-length`, such as server-sent events) on a project's host, which the edge relays for
  any bearer with a grant (`src/project-host-lease.ts`). Two things run to their end: an MCP
  `run` already executing (at most ten minutes), and a response of known length already being
  sent. A key also stops working, like any grant, once the deployment's `login.allowedEmails` no
  longer names its person's email.
- **Refusals.** A refused key is logged as `oauth.refusal` with `category: "protected-resource"`
  and a `reason`: `token_unknown_or_expired` for a malformed, forged, revoked or expired key, and
  `grant_not_live` for one the index still held when the account refused it. The platform does not
  rate-limit bad bearers, keys included: a string that fails the checksum is refused without any
  lookup, a well-formed one costs one KV read, and only a real key reads its person's account.
- **MCP.** At `/mcp` a key is outside the MCP authorization profile, which expects a token from
  the OAuth flow. The platform accepts it anyway, so you can use the same key everywhere. MCP
  clients that do the OAuth dance keep working as before.

Make one:

- **Dash:** Sessions → Personal access tokens. Pick the projects and an expiry (30 days by
  default, or none).
- **CLI:** `iterate tokens create --name my-script --project <slug>`. It expires in 30 days;
  add `--never-expires` for a key with no expiry. `iterate tokens list` and
  `iterate tokens revoke <pat_id>` do the rest. Each `tokens` command signs you in in the browser
  for that one call with the `account` scope, then ends that sign-in: the session `iterate login`
  stores on disk has `iterate` alone, so a copied config file can't mint keys.
- **Local dev:** `pnpm -s getin --token` prints one for `test@preview.iterate.test` on the `test`
  project.
- **Production, as an operator:** sign in to https://dash.iterate.com as yourself and use
  Sessions, or run
  `pnpm exec iterate --config prd tokens create --name <what for> --project <slug>` and approve
  the sign-in it opens. The key covers projects you are a member of.

Use one:

```sh
export ITERATE_BEARER_TOKEN=itk_…   # the CLI and the repo's scripts read it
pnpm exec iterate itx run --project <slug> --eval 'return await itx.whoami();'
eval "$(pnpm exec iterate mcp claude)"  # Claude Code against /mcp with the key
```

`iterate mcp claude` prints a command that reads the key from `$ITERATE_BEARER_TOKEN` when it
runs, so the key stays out of a transcript. To register the server with Claude Code for good,
`claude mcp add --transport http iterate https://mcp.iterate.com/ --header "Authorization: Bearer
$ITERATE_BEARER_TOKEN"` works too, but it writes the key in plain text into Claude Code's
configuration (`~/.claude.json`); give such a key an expiry.

## The operator bearer

`secrets.adminBearer` is the deployment's machine credential. It reaches every project as the
`admin` actor, so it's for automation that has no person behind it: the e2e harness creating
people and projects per test, the preview and deploy scripts and their readiness gates, the load
scripts, `project-seed.ts`. `/api` accepts it in-band (`authenticate({ type: "admin-secret" })`)
or as a bearer. Every other entry point refuses it and logs
`reason: "operator_bearer_not_accepted"`
(`src/oauth.ts`):

- `/mcp`, where an MCP client configured with it would hold every project;
- a project's host, where the project's app would be handed an operator over every project;
- a secret's OAuth callback (`/.secrets/oauth/callback`), which a project's member completes;
- a browser session, which only ever holds an OAuth token.

People and agents use personal access tokens instead. The one exception is a project you are not
a member of: a key can't reach it, so debugging a customer's project in production takes the
bearer, on `/api`, through the CLI or `apps/os/scripts/inspect-context.ts` (both read
`APP_CONFIG_ADMIN_API_SECRET` before `ITERATE_BEARER_TOKEN`):
`APP_CONFIG_ADMIN_API_SECRET=… pnpm exec iterate --config prd itx run --project <slug> …`
([acting as users and admins](../../../docs/dev-environments.md#acting-as-users-and-admins)).
