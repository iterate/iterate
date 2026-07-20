# Remote apps: independently deployed web apps as project capabilities

A web app deployed anywhere — your own workers.dev, a VPS, a laptop — can
mutually authenticate with a project in both directions:

- **Inbound**: the app connects to `os.iterate.com/api` _as its project_,
  using the project API key every project is born with.
- **Outbound**: the platform mounts the app as an ordinary itx capability
  (`itx.todos.add(...)`), dialing the app's Cap'n Web endpoint with a
  secret-substituted credential the app verifies.

The two credentials are deliberately different secrets: a stolen outbound
credential never grants `/api` access.

## Inbound: connect to the platform as your project

1. **Obtain the project API key.** Every project is born with a secret at
   `/secrets/project-api-key`, created with `visibility: "readable"` — the
   one secret kind whose material can be read back, as often as needed.
   Reveal it in the dashboard (the secret's page under `/secrets`) or from a
   script:

   ```ts
   const apiKey = await itx.secrets.get("/secrets/project-api-key").reveal();
   ```

   Readable secrets are structurally barred from egress — create and update
   both reject egress origins on one — so unlike every other secret it can
   never be substituted into any outbound request; it exists only to be
   verified against. Rotate it with an ordinary `update({ egress: { urls: [] },
material: newValue })`; visibility is an immutable birth-certificate fact.

2. **Connect from your app.** On node, the `iterate` package's client does
   the whole dance in one call:

   ```ts
   import { connectItx } from "iterate/node";

   using project = connectItx({
     baseUrl: "https://os.iterate.com",
     auth: {
       type: "project-secret",
       projectId: "prj_…",
       secret: process.env.ITERATE_PROJECT_API_KEY!,
     },
     projectId: "prj_…",
   });
   // The full project itx: streams, secrets, agents, workers, repos, …
   await project.streams.get("/app-events").append({ type: "…", payload: {} });
   ```

   On runtimes without the node `ws` package (a Cloudflare Worker, a
   browser-like environment), dial with raw Cap'n Web — the generated types
   come from the same package:

   ```ts
   import { newWebSocketRpcSession } from "capnweb";
   import type { UnauthenticatedOs } from "iterate/client";

   const os = newWebSocketRpcSession<UnauthenticatedOs>("wss://os.iterate.com/api");
   using session = os.authenticate({ type: "project-secret", projectId, secret });
   using project = session.projects.get(projectId);
   ```

   The credential is verified inside the project's secret Durable Object
   (material never leaves the secret system; the answer is one bit) and
   grants authority over exactly that one project — no admin, no user
   identity, no other projects.

## Outbound: mount your app as `itx.<name>`

1. **Expose a Cap'n Web WebSocket endpoint** in your app and verify a bearer
   token on the upgrade. No platform code required. This is literally the
   `worker.ts` you `wrangler deploy` to your own workers.dev:

   ```ts
   // worker.ts — the whole app. Dependency (same alias the platform uses):
   //   "capnweb": "npm:@iterate-com/capnweb@^0.10.0"
   import { RpcTarget, newWorkersRpcResponse } from "capnweb";

   class TodoApp extends RpcTarget {
     async add(title: string) {
       /* … */
     }
     async list() {
       /* … */
     }
   }

   export default {
     async fetch(request: Request, env: Env): Promise<Response> {
       const url = new URL(request.url);
       if (url.pathname !== "/api") return new Response("not found", { status: 404 });
       // The platform substitutes the Authorization header into the WebSocket
       // handshake; on Workers the upgrade IS this fetch, so a plain header
       // check guards the whole session.
       if (request.headers.get("authorization") !== `Bearer ${env.EGRESS_KEY}`) {
         return new Response("missing or invalid credential", { status: 401 });
       }
       return newWorkersRpcResponse(request, new TodoApp());
     },
   } satisfies ExportedHandler<Env>;
   ```

   ```jsonc
   // wrangler.jsonc — nothing fancy; add Durable Objects / Start assets as
   // your app grows (see apps/tanstack for the richer shape).
   {
     "name": "my-todos",
     "main": "./worker.ts",
     "compatibility_date": "2026-06-17",
   }
   ```

   `wrangler secret put EGRESS_KEY`, `wrangler deploy`, and the endpoint is
   `wss://my-todos.<account>.workers.dev/api`.

   The same thing on plain node (a VPS, a laptop) is the `ws` package plus
   `newWebSocketRpcSession`:

   ```ts
   import { RpcTarget, newWebSocketRpcSession } from "capnweb";
   import { WebSocketServer } from "ws";

   wss.on("connection", (socket, request) => {
     if (request.headers.authorization !== `Bearer ${process.env.EGRESS_KEY}`) {
       socket.close(4401, "missing or invalid credential");
       return;
     }
     newWebSocketRpcSession(socket, new TodoApp());
   });
   ```

2. **Mint the outbound credential as an ordinary project secret**, pinned to
   your app's origin (there is no born egress secret — one per app, on
   demand):

   ```ts
   await itx.secrets.get("/secrets/my-todos").create({
     egress: { urls: ["https://my-todos.<account>.workers.dev"] },
     material: { apiKey: "<the same value you gave wrangler secret put>" },
   });
   ```

3. **Mount the app** as a durable itx-expression capability naming
   `remoteCapability.get(url, { headers })`. The headers carry
   `getSecret(...)` placeholders — never material:

   ```ts
   await itx.capabilityHosts.get("/").provideCapability({
     type: "itx-expression",
     path: ["todos"],
     expression: [
       "remoteCapability",
       [
         "get",
         "wss://my-todos.<account>.workers.dev/api",
         {
           headers: {
             authorization: 'Bearer getSecret({ path: "/secrets/my-todos", field: "apiKey" })',
           },
         },
       ],
     ],
     instructions: "The project's todo list, served by an externally deployed app.",
   });
   ```

   Mount from an **in-scope script** — an agent script, or from outside via
   `itx.capabilityHosts.get("/").runScript("async (itx) => { ...the provide
above... }")`. `provideCapability` returns an ownership handle that
   revokes the mount when disposed, and a handle held over a Cap'n Web
   session (an external client, the CLI) is disposed when that session
   closes — so a mount made directly from a short-lived external session
   quietly unmounts with it. In-scope scripts drop the handle without
   disposal and the mount stays.

4. **Use it.** `itx.todos.add("milk")` now works for agents, scripts, and
   the dashboard alike. Each invoke re-evaluates the expression from project
   authority: the platform dials your endpoint through project egress (the
   approval gate sees the placeholder-form request), the referenced secret's
   Durable Object substitutes the handshake headers under its origin pin,
   and the remaining path walks your app's Cap'n Web root.

5. **Revoke** by revoking the mount or clearing the secret — the expression
   is a name, not a captured connection, so either is the whole off switch.
   Re-pointing the mount's URL at a different origin fails substitution
   instead of leaking the credential.

## Current semantics and limits

- **One dial per invoke.** The platform does not pool connections yet, and
  it does not close the per-invoke session — your app should idle-timeout
  its sockets.
- **Whole-project authority** for the inbound key; scoped keys are future
  work. Treat the key like the project's root credential.
- Stream processors can in principle live behind the same lane (a wake
  subscription whose expression names `remoteCapability.get(...).processor
.wakeStreamSubscriber`), but that path is not yet exercised.

Proofs: `apps/os/e2e/vitest/remote-apps.e2e.test.ts` walks both directions,
including the mutual-auth header check against a real external server.
