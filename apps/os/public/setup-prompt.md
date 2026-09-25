# Self-host iterate OS on a personal Cloudflare account

A recipe for a coding agent. If you were asked to set someone up with iterate.com, or with a
self-hosted iterate, follow it.

End state: `https://iterate.<subdomain>.workers.dev/mcp` is a working remote MCP server in the user's
agents. iterate OS (`apps/os` in https://github.com/iterate/iterate) is one Worker: sign-in and
OAuth, `/mcp` (one tool, `run({ project, script })`, which evaluates `async (itx) => …` against a
project), and a Durable Object per project.

Work in the directory you were started in.

Whenever the user has to act somewhere else (the browser, or e.g. typing `/mcp` into their client), end
your turn or wait on a background command. Don't ask a blocking question: it takes over their prompt
box.

One browser flow at a time, in order: the dash sign-in and project (step 6) finishes before any
client's OAuth (step 8) starts. Every one of them shows the same iterate sign-in and consent pages,
so say which flow a page is for when you open it.

## Requirements

- **Workers Paid**: the config declares paid-plan limits.
- **R2** enabled.
- **Artifacts** (closed beta): every project's code lives in an Artifacts git repo. Without access,
  deploy fails with `10015`. Strip the binding and the deploy succeeds: sign-in and MCP work, but
  project creation fails with
  `repo /repos/config: creation failed — Cannot read properties of undefined (reading 'get')`.

## 1. Build

```bash
git clone --depth 1 https://github.com/iterate/iterate   # gitignored
cd iterate && pnpm install
CLOUDFLARE_ENV=self-host pnpm --filter os build  # writes apps/os/dist/server/wrangler.json
```

## 2. Log in

- Always run `wrangler login`, even if wrangler already shows a login: you can't know which account
  the user wants. Run it with `--browser=false` in the background and `open` the URL. The user signs
  into the dash as the right Cloudflare user, picks the account on Cloudflare's consent page and
  clicks Allow. So don't ask which account up front. The login command exits once they're done, and
  `wrangler whoami` then shows the account. Ask only if it shows several.
- Use `pnpm exec wrangler` from `iterate/apps/os`, always with `--config dist/server/wrangler.json`.
  Without it, wrangler picks whichever config the last build pointed it at, and iterate's own
  configs pin iterate's `account_id`.

## 3. Check the account (before deploying)

Use the token from `wrangler auth token` against
`https://api.cloudflare.com/client/v4/accounts/<id>`:

- `GET /workers/subdomain`: the origin is `https://iterate.<subdomain>.workers.dev`.
- `GET /r2/buckets` must succeed. If not, the user enables R2 in the dash.
- `GET /artifacts/namespaces`: `10004 Access denied by feature gate` means no access. The access
  form is https://forms.gle/DwBoPRa3CWQ8ajFp7 (name, account ID, use case, Workers Paid y/n, repo
  count; approval takes 2–4 weeks). Hand the user a prefilled link
  (`viewform?usp=pp_url&entry.<id>=…`); they submit it. Until access is granted, projects won't
  work. Deploy anyway only if the user wants to: delete `artifacts` from `dist/server/wrangler.json`
  after every build.
- Workers Paid can't be checked with these scopes. A successful deploy proves it.

## 4. Secrets

Write `.secrets` (gitignored, mode 600) and keep it. It's the only copy of these values.

```
APP_CONFIG={"login":{"password":"<generated, alphanumeric>"},"secrets":{"adminBearer":"<openssl rand -hex 32>"}}
APP_CONFIG_SECRETS__KEY=<openssl rand -hex 32>
```

- `password`: anyone who has it can sign in as any email they type.
- `adminBearer`: operator access to every project over `/api` (`/mcp` refuses it). You use it to
  find the user's project.
- The key encrypts project secrets at rest; losing it loses them.

Never print these in chat. When the user needs the password, copy it (it's JSON inside a dotenv
line): `sed -n 's/^APP_CONFIG=//p' .secrets | jq -j .login.password | pbcopy`. Then tell them it's on
their clipboard, and that it came from `.secrets` (give its absolute path) so they can find it later.

## 5. Deploy

```bash
pnpm exec wrangler deploy --config dist/server/wrangler.json --secrets-file /abs/path/to/.secrets
```

The first deploy creates the KV namespaces and R2 bucket by name. If a deploy fails
after that, the next one fails with `10014 ... already exists`: delete the empty `iterate-itx-kv` /
`iterate-oauth-kv` and retry. To update: `git pull`, rebuild, deploy. Without `--secrets-file` the
existing secrets are kept.

The deploy doesn't create the Artifacts namespace the config names (`iterate-repos`), and the
Worker's binding doesn't either, whatever Cloudflare's docs say. Without it, project creation fails
with `repo /repos/config: creation failed — Namespace is not active`. So create it before anyone
signs in (it's a no-op if `GET /artifacts/namespaces/iterate-repos` already finds it):

```bash
curl -X POST https://api.cloudflare.com/client/v4/accounts/<id>/artifacts/namespaces \
  -H "Authorization: Bearer $(pnpm exec wrangler auth token --config dist/server/wrangler.json | tail -1)" \
  -H 'content-type: application/json' -d '{"namespace":"iterate-repos"}'
```

## 6. First sign-in and project

Signing in at the origin creates nothing: the organization and project are created on the consent
page, when an app connects. So send the user to the dash's connect page,
`https://dash.iterate.com/.auth/connect?issuer=<origin>` (the origin's landing page links there too).
They click Continue, sign in with any email and the password, then name the organization and project
on the consent page. Wait for them, then find the slug and the email they signed in with yourself,
with the admin bearer (from `iterate/apps/os`, where the SDK resolves). Ask only if there are
several:

```bash
ADMIN_BEARER=<adminBearer> pnpm exec tsx --eval 'import("iterate/node").then(async ({ connectIterate }) => {
  const c = await connectIterate({ baseUrl: process.argv[1], auth: { type: "admin-secret", secret: process.env.ADMIN_BEARER } });
  console.log((await c.session.projects.list()).map((p) => `project ${p.slug}`).join("\n"));
  console.log((await c.session.users.list()).map((u) => `user ${u.email}`).join("\n")); process.exit(0); })' <origin>
```

The project row exists even when Artifacts is missing and project creation failed.

Every iterate app link you give the user carries the issuer:
`https://<app>/.auth/connect?issuer=<origin, URL-encoded>`. A bare `https://dash.iterate.com` (or
voice, …) signs in to iterate's hosted platform instead. The dash's sidebar links to the other apps
drop the issuer too, so don't send the user through them.

## 7. Verify

`/mcp` takes a person's bearer, so verify it as the user: sign in with their email and the password,
and mint a personal access token for their project that expires in an hour (what the dash's
Sessions page does). From `iterate/apps/os`, where capnweb resolves:

```bash
TOKEN=$(PASSWORD=<password> pnpm exec tsx --eval 'import("capnweb").then(async ({ newHttpBatchRpcSession }) => {
  const [origin, email, slug] = process.argv.slice(1);
  const login = await fetch(`${origin}/login`, { method: "POST", redirect: "manual", headers: { origin },
    body: new URLSearchParams({ email, password: process.env.PASSWORD, next: "/" }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const account = () => newHttpBatchRpcSession(new Request(`${origin}/api`, { headers: { origin, cookie } }))
    .authenticate({ type: "from-server-cookie" });
  const project = (await account().projects.list()).find((p) => p.slug === slug);
  const { token } = await account().grants.mint({ name: "setup check", projects: [project.id], expiresAt: Date.now() + 3600_000 });
  console.log(token); })' <origin> <email> <slug>)
```

`/mcp` is stateless streamable HTTP. The token reaches one project, so `project` may be omitted:

```bash
jq -nc --arg s 'async (itx) => ({ who: await itx.whoami(), files: await itx.repos.get("/repos/config").listFiles() })' \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"run",arguments:{script:$s}}}' |
curl -s <origin>/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d @-
```

Expect the project's id, slug and URL, plus the config repo's files. Then revoke the key: it is the
user's, and the check is done. A key can end itself (`logout`), so no sign-in is needed:

```bash
TOKEN=$TOKEN pnpm exec tsx --eval 'import("capnweb").then(async ({ newHttpBatchRpcSession }) => {
  await newHttpBatchRpcSession(new Request(`${process.argv[1]}/api`, { headers: { authorization: `Bearer ${process.env.TOKEN}` } }))
    .authenticate({ type: "from-server-cookie" }).logout(); })' <origin>
```

`repo /repos/config: not created` means project creation failed. Check the project's page in the dash for the reason. For `Namespace
is not active`, create the namespace (step 5), then have the user create the project again from the
dash's projects page. That starts a new attempt.

## 8. Connect the user's agents

- Register `<origin>/mcp` as a remote HTTP MCP server in the client you are running in, and only
  that one, e.g. Claude Code:
  `claude mcp add --transport http -s user iterate-<subdomain> <origin>/mcp`. Don't set up the
  user's other clients; the final message tells them how.
- Registering may open the sign-in page by itself (e.g. `codex mcp add` does). If it does, don't also
  `open` it or run a separate login command: that pops open the same page twice and confuses the user.
- The user signs the client in through the browser (any email plus the password). E.g. in Claude
  Code: `/mcp`, pick the server, authenticate; after that, `claude mcp list`/`codex mcp list` shows it as connected.
- Then try the server's `run` tool in this session straight away. Some hosts attach a newly added
  server once it's signed in (e.g. Claude Desktop's Code tab does), so look for it among your tools
  (e.g. Claude Code's deferred tools). Call it with `async (itx) => itx.whoami()`: no `project`
  needed when the token reaches one project. If the tool isn't there, the client only loads servers
  at startup. Tell the user to start a new session and ask it to run the same check.
- Finish with one message that has some things to get started with (for links, show them in full so the user gets familiar with them):
  - `<origin>/mcp` (remote HTTP) for other clients, where the password lives, and that each client signs in the same way;
  - the dash: `https://dash.iterate.com/.auth/connect?issuer=<origin>`;
  - voice: `https://voice.iterate.com/.auth/connect?issuer=<origin>`, to talk to the project from
    the laptop mic. The page installs the voice agent itself, asking for an OpenAI key the first
    time.
  - kit: `https://k.iterate.com/.auth/connect?issuer=<origin>`, to flash a voice board (e.g. a Home
    Assistant Voice Preview Edition) over USB from Chrome or Edge, so it talks to the project too.
    It installs the voice agent the same way.

Google, Cloudflare or email-code sign-in, and custom domains: `apps/os/SELF-HOSTING.md`.
