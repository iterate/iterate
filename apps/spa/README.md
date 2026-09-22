# Static SPA

The pure-client archetype: four files in `public/` — `index.html`, `app.js`, `oauth.js`, `client-logo.svg` — served from any
static host, no build, no server of their own. The page runs the OAuth dance itself (discovery,
a one-time public-client registration, PKCE, refresh), then opens one WebSocket to the platform's
`/api` bare and presents the access token IN the `authenticate` call — capnweb's own pattern:

```js
const iterate = newWebSocketRpcSession(new WebSocket("wss://os.iterate2.com/api"));
const api = iterate.authenticate({ type: "bearer", token });
const projects = await api.projects.list(); // pipelined with the token's round trip
```

capnweb comes from a CDN through a native import map (`@iterate-com/capnweb`). Tokens live in
`sessionStorage` (this tab, until it closes); the issuer renews an interactive grant's access
token hourly, and the socket is closed by the platform at the grant's expiry or revocation.

Run locally: `pnpm --filter @iterate-com/spa dev` serves the files at http://localhost:8799; open
`http://localhost:8799/?issuer=http://localhost:8797` against a local os-next (`pnpm --dir ../os-next dev -- --port 8797`).
Deploy: `pnpm --filter @iterate-com/spa deploy` → https://iterate-spa.iterate.workers.dev, which
talks to https://os.iterate2.com by default.
