# X integration prototype

`@iterate-com/x` is a userspace X client and reply-drafting facet. The package can run in either an Iterate-operated project or a customer's project. OAuth client ownership is independent of where it runs. OS handles OAuth, encrypted tokens, refresh and origin-pinned egress; the package receives secret references, never token values.

The prototype reads account identity, individual posts, mentions and bookmarks, and sends a reviewed reply. It does not implement DMs, webhook delivery, scheduled polling, cross-project identity lookup or unattended replies. Mentions are fetched on demand; pass `{ sinceId, paginationToken }` to follow all pages. X requires prior written approval for AI-powered automated reply bots ([automation rules](https://help.x.com/en/rules-and-policies/x-automation)); this package does not obtain that approval or start an automatic reply loop.

## Connect accounts

Create a confidential **Web App / Automated App or Bot** OAuth 2.0 client in the X developer console. Register the exact callback `<OS origin>/api/integrations/x/callback`. OAuth uses PKCE and HTTP Basic client authentication.

For Iterate's client, configure Doppler's `APP_CONFIG_INTEGRATIONS__X` with `{ "oauthClientId": "…", "oauthClientSecret": "…" }`. Preview deployments use the dummy-petshop provider. For a project's own client, store credentials with the existing secret API:

```ts
await itx.secrets.set(
  "/secrets/x-bot",
  { clientId, clientSecret },
  {
    urls: ["https://api.x.com"],
  },
);
const { authorizationUrl } = await itx.integrations.connect("x", {
  connection: "bot",
  client: "project", // use "iterate" for the deployment's client
  scopes: ["tweet.write"],
});
// Open authorizationUrl and authorize the account that will reply.
```

Every connection requests `tweet.read`, `users.read` and `offline.access`. Request `bookmark.read` to read bookmarks; posting requires `tweet.write`. X charges API use to the developer app; this package adds no metering or recharge system. Disconnecting removes Iterate's token and loans; revoke the app's grant in X's connected-app settings as well if required.

A sender connects their X account under **Dash → Account → Connections**, using Iterate's client, then lends it to the project through **Integrations → X → Your accounts**. A project-created credential alone is not treated as proof of a person's identity. `/2/users/me` supplies the stable X account ID; handles are display names. Re-consent as a different account is rejected before replacing the existing token.

The intended hosted product lets a user connect @Jonas to a project, then mention @iterate and receive a reply from that project. That needs a trusted stable-X-ID-to-project route and a central @iterate publisher. It does not require giving Iterate's bot project the user's personal API token. Separately, a customer can grant bookmarks or posting access, and activity subscriptions can feed a project stream. Subscriptions, usage attribution, budgets and customer cost pass-through are not implemented here.

This prototype requires sender and bot connections in the same project. An `@iterate` entry point for people who are not members of the bot project still needs an OS-owned account lookup and explicitly authorized dispatch into the person's project. Do not invite arbitrary people into a privileged bot project as a substitute.

## Install and draft

Install the agents app in the project first, then mount this facet on the project root. Use the full commit's pkg.pr.new URL from this PR:

```ts
import { installXBot, xBotFolder } from "@iterate-com/x/install";
import type { XBotDurableObject } from "@iterate-com/x/bot";

await installXBot(
  itx,
  xBotFolder("https://pkg.pr.new/iterate/iterate/@iterate-com/x@<full-commit-sha>"),
  { botConnection: "bot" },
);
const bot = itx.facets.get<XBotDurableObject>("x-bot");
const mentions = await bot.mentions();
const draft = await bot.prepare({ postId: "<numeric-post-id>", senderConnection: "me" });
// Review draft.draft before calling send. No send is triggered by prepare.
await bot.send({ postId: draft.postId, text: "Your reviewed reply" });
```

`prepare` fetches the post from X, verifies the author against the verified personal account connected to the project and requires an X mention entity for the bot (which can also occur in a reply thread). It rejects self-invocation. The drafting agent has its `itx` sandbox masked and receives the public post only. This is a project-admin tool: any code with root facet access, including other project agents, can explicitly call `send`; it is not a human-presence check or a permission boundary against other project administrators.

Each post has one persisted receipt, available through `bot.receipt(postId)`: `preparing`, `draft`, `failed`, `sending`, `sent`, or `unknown`. Concurrent/repeated preparations reuse it without more X reads. Failed drafts can be explicitly retried; each attempt uses a new agent context so a late answer from an earlier attempt cannot settle the new draft. Agent contexts remain stored; the prototype has no automatic retention cleanup. Publishing rechecks the account binding and claims the receipt before one POST. A received 4xx rejection other than 408 returns the receipt to `draft`, allowing the caller to correct the text or permissions and explicitly try again. The original draft is preserved separately from `sentText`. An ambiguous POST failure becomes `unknown`, and cannot be retried through `send`. After a facet restart, interrupted preparations become `failed`, interrupted sends become `unknown` when inspected. Check X manually before resolving an uncertain send; the prototype has no reset/reconciliation command. Agent drafting waits at most 60 seconds. API rate limits surface as errors; there is no background retry loop.

Bookmarks can be read independently of the bot:

```ts
import { XClient } from "@iterate-com/x/client";
const x = new XClient((request) => itx.fetch(request), "me");
const account = await x.me();
const page = await x.bookmarks(account.id);
```

Validation uses a fake X provider with PKCE, Basic client authentication, refresh-token rotation and `/users/me` responses. These tests do not establish that a live app has credits, endpoint entitlements or X's approval for automated replies.
