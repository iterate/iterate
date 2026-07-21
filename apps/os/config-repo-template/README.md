# Iterate config repo

This repo is seeded at project creation by the repo stream processor.

The project worker entrypoint is `worker.ts` (TypeScript). The worker build
pipeline bundles it and the files it imports into loader-ready code on first
use, so committing a change here changes the running worker on its next use.
The platform passes this repo's files and build options directly to
`@cloudflare/worker-bundler`; when `package.json` declares dependencies, that
library attempts to install and bundle them.

`apps/todo` and `apps/guestbook` are deliberately basic browser examples.
Each contains only `server.tsx` and `client.tsx`: the server exports a
Durable Object and the client becomes a separately served browser module. JSX is
compiled by `createApp`; React and React DOM are ordinary `package.json`
dependencies, while Cap'n Web and LiveState come from `iterate/sdk/capnweb`
and `iterate/sdk/capnweb/react`. Preview builds replace the declared `iterate`
spec with that deployment's exact pkg.pr.new artifact before bundling. There is no
app-local Vite config, router generator, or framework adapter. Iterate injects
its small status overlay into the HTML response in production.
Their two-file layout is only an example: app refs may choose arbitrary server
and client entry points from the complete `files` map passed to the bundler.

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
`iterate/sdk/capnweb` module first-party apps use. That same entry re-exports
Cap'n Web's `RpcTarget` and `newWorkersWebSocketRpcResponse`, guaranteeing one
class identity across app and SDK code. `InternalApp` uses them to push its event projection
with the same snapshot-and-patch implementation. The explicit classes are
intentional: there is no
`authenticatedApp` wrapper hiding where authentication happens or which
authority crosses the wire.
