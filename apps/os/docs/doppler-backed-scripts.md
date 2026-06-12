# Doppler-Backed Scripts

Some package scripts need app secrets and app config, but the script itself
should not decide which environment to target. That choice belongs to Doppler.

## Pattern

Keep `package.json` simple:

```json
{
  "scripts": {
    "cli": "tsx ./scripts/cli.ts"
  }
}
```

Put the environment bootstrap in a small, documented TypeScript script:

- If `DOPPLER_CONFIG` is already set, run the tool directly.
- If not, run `doppler run -- ...` with no `--project` and no `--config`.
- Let local `doppler setup` choose the default project/config.
- Let explicit wrappers choose production or preview.

## Usage

From an app directory that has Doppler setup:

```bash
pnpm cli rpc --help
```

Target a specific config explicitly:

```bash
doppler run --config prd -- pnpm cli rpc --help
doppler run --config preview_3 -- pnpm cli rpc --help
```

Local operational commands should also live under `pnpm cli`, not as
environment-pinning package scripts. For example, the Iterate config base
Artifact repair command runs through the local script router:

```bash
pnpm cli artifacts seed-config-base
doppler run --project os --config dev_jonas -- pnpm cli artifacts seed-config-base
```

Do not put `--project os` or `--config prd` in the default script. That makes
plain local commands surprisingly target production and bypasses the user's
local Doppler setup.

## App Config Defaults

Shared tools should prefer app config env vars when they exist. For deployed
apps, Doppler already provides `APP_CONFIG_BASE_URL` and auth secrets such as
`APP_CONFIG_ADMIN_API_SECRET`; scripts should not re-map those in every app.

Use `APP_CONFIG_BASE_URL` for both configured deployments and ad hoc local
overrides. When wrapping a local override with `doppler run`, pass
`--preserve-env=APP_CONFIG_BASE_URL` so Doppler does not replace it with the
configured deployment URL.

## Local Admin Browser Cookie

The `/admin` UI uses a root itx WebSocket. Browsers cannot add an
`Authorization` header to WebSocket handshakes, so admin-token access must
first be converted into the HttpOnly `iterate-admin-auth` cookie by posting the
admin token to `/api/itx/admin-cookie`.

For local dev, keep the token inside Doppler and use a one-shot localhost
bridge. The bridge forwards only the `Set-Cookie` header to your browser and
then redirects back to OS:

```bash
doppler run --project os --config dev -- node -e '
const http = require("node:http");
const { baseUrl } = require("./.alchemy/dev-server.json");
const target = baseUrl;
const port = 5199;
const server = http.createServer(async (_req, res) => {
  const response = await fetch(`${target}/api/itx/admin-cookie`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: process.env.APP_CONFIG_ADMIN_API_SECRET,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) res.setHeader("set-cookie", setCookie);
  res.statusCode = response.ok ? 302 : 502;
  res.setHeader("location", `${target}/admin/streams/global`);
  res.end(response.ok ? "admin cookie set" : "admin cookie bridge failed");
  server.close();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://localhost:${port}/ once in your browser.`);
});
setTimeout(() => server.close(), 60000).unref();
'
```

Adjust `port` and the Doppler config for the environment you are testing. The
cookie is host-scoped, not port-scoped, so setting it from `localhost:5199`
also makes it available to `localhost:<dev-port>`.
