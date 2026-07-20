# Iterate config repo

This repo is seeded at project creation by the repo stream processor.

The project worker entrypoint is `worker.ts` (TypeScript). The worker build
pipeline bundles it — together with any files it imports and the npm
dependencies in `package.json` — into a loader-ready worker on first use, so
committing a change here changes the running worker on its next use.

`apps/todo` and `apps/guestbook` are deliberately basic browser examples.
Each contains only `server.tsx` and `client.tsx`: the server is a Durable
Object, and the client is a separately served browser bundle whose React
imports remain direct `esm.sh` URL imports. There is no app-local npm install,
Vite config, router generator, or full-stack framework adapter.

## Authenticated web apps

`InternalApp` in `worker.ts` is a complete project-member-only app. Its normal
HTTP routes use auth as a partial fetch:

```ts
using itx = await this.env.ITX.get();
const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(request);
if (authResponse) return authResponse;

// Auth inspected headers only. The original request body is still available.
```

The same app owns an unauthenticated Cap'n Web endpoint at `/api`. Its public
target exposes one method, `authenticate()`, which exchanges the exact-origin
HTTP-only cookie for an actor and returns an app-specific session capability:

```ts
class PublicApi extends RpcTarget {
  constructor(
    private readonly itxBinding: ItxBinding,
    private readonly request: Request,
  ) {
    super();
  }

  async authenticate(credentials: ProjectAuthCredentials) {
    using itx = await this.itxBinding.get();
    const actor = await itx.auth
      .get({ policy: "project-member" })
      .authenticate(this.request, credentials);
    return new AppSession(actor);
  }
}
```

The browser calls
`publicApi.authenticate({ type: "from-server-cookie" })` over that WebSocket.
It receives only `AppSession`, never the project-wide `itx` capability. Add RPC
methods and getters to `AppSession` to define exactly what the browser may do.

`LiveState` and its read-only `LiveStateRpcTarget` come from the same
`iterate/live-state` module first-party apps use, while Cap'n Web's `RpcTarget`
and `newWorkersWebSocketRpcResponse` come directly from
`@iterate-com/capnweb`. `InternalApp` uses them to push its event projection
with the same snapshot-and-patch implementation. The explicit classes are
intentional: there is no
`authenticatedApp` wrapper hiding where authentication happens or which
authority crosses the wire.
