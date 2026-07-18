# Iterate config repo

This repo is seeded at project creation by the repo stream processor.

The project worker entrypoint is `worker.ts` (TypeScript). The worker build
pipeline bundles it — together with any files it imports and the npm
dependencies in `package.json` — into a loader-ready worker on first use, so
committing a change here changes the running worker on its next use.

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

`iterate/app` provides `RpcTarget`, `newWorkersWebSocketRpcResponse`,
`LiveState`, and `LiveStateRpcTarget`. `InternalApp` uses them to push its event
projection with the same snapshot-and-patch LiveState protocol used by Iterate's
first-party apps. The explicit classes are intentional: there is no
`authenticatedApp` wrapper hiding where authentication happens or which
authority crosses the wire.
