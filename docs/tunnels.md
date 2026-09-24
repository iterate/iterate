# Tunnels

Captun exposes a local server or a test fixture through the shared gateway at
`https://tunnels.iterate.com`. `apps/tunnels` owns the existing `tunnels-prd`
Worker and its `CaptunServerShard` Durable Object namespace. Development and CI
use the same gateway.

Start the local server, then run from the repository root:

```sh
pnpm tunnel 3000 --name jonas
```

The public URL is `https://jonas.tunnels.iterate.com`. Leave out `--name` for a
random name, or pass a URL instead of a port:

```sh
pnpm tunnel http://127.0.0.1:8788
pnpm tunnel --help
```

The command runs the pinned `captun` CLI. It reads `CAPTUN_TOKEN` from the
environment when supplied, otherwise from Doppler `_shared/preview`, and uses
a temporary private config that is removed when the process exits. It does not
replace personal Captun settings. Ctrl-C closes the connection. HTTP request
bodies, response streams and WebSocket connections pass through the tunnel.
The exposed server's own authentication still controls access to its contents.

A tunnel forwards traffic; it does not change an application's canonical URL,
OAuth issuer or registered callback URLs. Applications with those settings need
them configured for their public hostname.

## Fixtures used by deployed tests

Before the platform cutover, OS tests used `withTunnel()` to expose a local
fetch handler to deployed Workers; local runs used a loopback HTTP server. That
helper belonged to the retired platform. Current tests can use Captun's public
API directly when they need a real public callback endpoint:

```ts
import { createCaptunTunnel } from "captun";

using tunnel = await createCaptunTunnel({
  gateway: "https://tunnels.iterate.com",
  token: process.env.CAPTUN_TOKEN,
  fetch(request) {
    return Response.json({ method: request.method, path: new URL(request.url).pathname });
  },
});

// Give this URL to the deployed Worker as its callback/fixture URL.
console.log(tunnel.url);
```

Add the same pinned Captun dependency as `apps/tunnels` to the calling workspace,
and run through a Doppler config with `CAPTUN_TOKEN`. Use a random name for each
test; disposing the handle closes its connection. The workspace override pins
Captun's Cap'n Web dependency to the protocol build used by the gateway.

## Maintaining the gateway

`pnpm --dir apps/tunnels smoke` opens a disposable tunnel with the same CLI and
checks HTTP bodies/headers plus text and binary WebSocket forwarding, then
closes its local server and tunnel. This uses the existing gateway and does not
deploy anything.

`envs.ts` owns the production Worker name, account and hostname. Doppler project
`tunnels`, config `prd`, supplies the deploy credentials and `CAPTUN_TOKEN`.
The deployment workflow builds and updates the existing Worker in place.

```sh
pnpm --dir apps/tunnels ensure-resources --env prd
pnpm --dir apps/tunnels deploy --env prd
```

The DNS command ensures the gateway and wildcard records; it does not delete
anything. Keep both `tunnels.iterate.com/*` and `*.tunnels.iterate.com/*` routes,
their proxied DNS, and the existing Durable Object namespace. Deleting or
replacing the Worker/namespace interrupts other developers' open tunnels.

The separately deployed `captun` / `captun-public` Workers and the public
`captun.sh` service are also retained; they are separate from this gateway.
