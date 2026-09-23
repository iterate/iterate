# Static SPA

The pure-client archetype: four files in `public/` — `index.html`, `app.js`, `oauth.js`, `client-logo.svg` — served from any
static host, no build, no server of their own. The page runs the OAuth dance itself (discovery,
a one-time public-client registration, PKCE, refresh), then opens one WebSocket to the platform's
`/api` bare and presents the access token IN the `authenticate` call — capnweb's own pattern:

```js
const iterate = newWebSocketRpcSession(new WebSocket("wss://os.iterate.com/api"));
const api = iterate.authenticate({ type: "bearer", token });
const projects = await api.projects.list(); // pipelined with the token's round trip
```

capnweb comes from a CDN through a native import map (`@iterate-com/capnweb`). Tokens live in
`sessionStorage` (this tab, until it closes); the issuer renews an interactive grant's access
token hourly, and the socket is closed by the platform at the grant's expiry or revocation.

Run locally: `pnpm --filter @iterate-com/spa dev` serves the files at http://localhost:8799; open
`http://localhost:8799/?issuer=http://localhost:8797` against a local OS (`pnpm --dir ../os dev -- --port 8797`).
Deploy: `pnpm --filter @iterate-com/spa run-script deploy --env prd` → https://iterate-spa.iterate.workers.dev, which
talks to https://os.iterate.com by default.

Production deploys automatically on main via `.depot/workflows/deploy-spa.yml`, including changes
in `apps/browser-extension`. `envs.ts` owns worker names/accounts; Doppler `project-worker`
supplies credentials. `--env preview` targets the separate preview account.

`pnpm --filter @iterate-com/spa build` copies the static files and packages the Chrome extension
using Python 3's standard ZIP library. `/downloads/` serves the versioned unpacked extension and
installation/update instructions. The app itself still needs no build or server to run.
