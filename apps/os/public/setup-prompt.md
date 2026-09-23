# Set up OS Next for me

You are helping a person deploy **OS Next** into their own Cloudflare account and start using it:
one Cloudflare Worker that makes each project a programmable workspace, with one MCP server (`/mcp`)
whose one tool, `run`, evaluates an `async (itx) => …` script against a project. Work through these
steps in order, and stop to wait for the person wherever a step says so.

## 1. Deploy it

Requirements: a Cloudflare account on the **Workers Paid** plan (the Worker declares paid-plan limits
and binds Browser Run and the Worker Loader), Node and pnpm, and `openssl`. No domain is needed.

```bash
git clone https://github.com/iterate/iterate && cd iterate
pnpm install
OS_NEXT_ENV=self-host pnpm --filter os build  # writes apps/os/dist/server/wrangler.json
npx wrangler login                          # opens the browser; the person picks the account
```

Ask the person to choose a sign-in password before the next step. Do not invent one for them, and
never paste secrets into the chat: write the file, deploy, delete the file.

```bash
cat > .secrets <<EOF
APP_CONFIG={"login":{"password":"<the password they chose>"}}
APP_CONFIG_SECRETS__KEY=$(openssl rand -hex 32)
EOF
npx wrangler deploy --config apps/os/dist/server/wrangler.json --secrets-file .secrets
rm .secrets
```

The first deploy creates the two KV namespaces and the R2 bucket by name and prints
the Worker's URL — `https://iterate.<their-subdomain>.workers.dev`, `<origin>` below. Tell the person
to keep a copy of `APP_CONFIG_SECRETS__KEY` somewhere safe: it encrypts their projects' secrets at rest.

## 2. Sign in

Ask the person to open `<origin>` and sign in with their email and the password. Anyone who knows the
password can sign in as the email they type: the password is the membership, the email is the name
tag. Their first sign-in creates an organization and a project on the consent page.

## 3. Connect over MCP

Add `<origin>/mcp` to your MCP client as a remote server. It signs in through the same page. Most
clients only load servers at startup, so the person may need to restart the client or open a new
chat before the `run` tool appears — say so, and wait for them.

Once `run` is there, prove the connection with one script:

```js
async (itx) => ({ who: await itx.whoami(), url: await itx.url() });
```

It answers with the project's id and slug and its public URL under `<origin>/projects/<slug>/`.

## 4. Hand over the dash

Projects, organizations, sessions and personal access tokens are managed in the dash, an app iterate
hosts that connects to any iterate platform. Send the person to
`https://dash.iterate.com/.auth/connect?issuer=<origin>` — the page names their platform's host and
asks before connecting the browser to it.

Docs: `apps/os/SELF-HOSTING.md` and `apps/os/README.md` in the repository.
Source, and where to start if something breaks: https://github.com/iterate/iterate
