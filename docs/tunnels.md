# Tunnels

Iterate runs its own small captun gateway in `apps/tunnels`, deployed at
`https://tunnels.iterate.com`. It gives local processes and CI jobs public
HTTPS URLs without embedding test or callback routes into product workers.

Use it when something outside your machine needs to call back into code that is
running locally or inside a CI runner:

- Slack/GitHub webhooks
- OAuth callbacks during local development
- e2e fixtures that deployed Workers must reach
- browser or agent access to a local OS dev server

## How It Works

A client opens a long-lived captun connection to the gateway using
`CAPTUN_TOKEN`. The gateway routes public requests for a tunnel name back over
that connection. With `CUSTOM_HOSTNAME=tunnels.iterate.com`, named tunnels use
subdomains:

```text
https://<name>.tunnels.iterate.com
```

`CAPTUN_TOKEN` lives in Doppler shared dev/preview configuration. In normal
repo use, run tunnel commands inside Doppler instead of exporting the token by
hand:

```bash
doppler run --project os --config dev -- ...
```

The installed captun package uses the Iterate Cap'n Web fork from
`https://github.com/iterate/capnweb/releases/download/v0.8.0-websocket.1/capnweb-0.8.0.tgz`.
That build supports forwarding WebSocket upgrade responses over Cap'n Web, so
tunneled URLs work for both HTTP and WebSockets.

## OS Dev Server

For the OS Vite dev server, set a stable tunnel name:

```bash
CAPTUN_TUNNEL_NAME=jonas pnpm dev
```

The captun Vite plugin in `apps/os/vite.config.ts` publishes the dev server at:

```text
https://jonas.tunnels.iterate.com
```

Use a stable personal name for webhook and OAuth work, because third-party apps
usually store exactly one callback URL.

## Programmatic Fixtures

OS e2e tests should use `withTunnel()` from
`apps/os/e2e/test-support/tunnel.ts`. It returns a loopback URL for local dev
targets and a captun URL when `APP_CONFIG_BASE_URL` points at a deployed
worker:

```ts
import { withTunnel } from "../test-support/tunnel.ts";

const fixture = await withTunnel({
  path: "/mock-api",
  fetch(request) {
    return Response.json({ ok: true, url: request.url });
  },
});

try {
  console.log(fixture.url);
} finally {
  await fixture.close();
}
```

Other tests and scripts can create a named public fixture directly without
opening a local port:

```ts
import { createCaptunTunnel } from "captun";

const tunnel = await createCaptunTunnel({
  gateway: process.env.CAPTUN_GATEWAY || "https://tunnels.iterate.com",
  name: "my-fixture",
  token: process.env.CAPTUN_TOKEN,
  fetch(request) {
    return Response.json({ ok: true, url: request.url });
  },
});

console.log(tunnel.url); // https://my-fixture.tunnels.iterate.com

// Later:
tunnel[Symbol.dispose]();
```

Omit `name` for a random tunnel. Prefer random names for automated tests unless
a third-party integration requires a stable URL.

## CI

Depot jobs can use the same gateway. The workflow needs `DOPPLER_TOKEN`, then
the job should enter a config that contains `CAPTUN_TOKEN`:

```yaml
- name: Captun-backed test
  env:
    DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
  run: doppler run --project os --config dev -- pnpm e2e
```

For preview e2e tests, prefer Doppler-managed preview/shared config so the
runner and the deployed worker agree on the gateway and secrets.

## See Also

- [Dev environments](dev-environments.md#tunnels-and-webhooks)
- [Testing](testing.md#using-tunnels-in-tests)
- [`apps/tunnels`](../apps/tunnels/src/worker.ts)
