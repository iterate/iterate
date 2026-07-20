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

2. **Connect from your app** with the `iterate` package's node client (or
   raw Cap'n Web against `wss://os.iterate.com/api`):

   ```ts
   import { connectItx } from "iterate/node";

   using session = connectItx({ baseUrl: "https://os.iterate.com" });
   using os = session.authenticate({
     type: "project-secret",
     projectId: "prj_…",
     secret: process.env.ITERATE_PROJECT_API_KEY!,
   });
   using project = os.projects.get("prj_…");
   // The full project itx: streams, secrets, agents, workers, …
   await project.streams.get("/app-events").append({ type: "…", payload: {} });
   ```

   The credential is verified inside the project's secret Durable Object
   (material never leaves the secret system; the answer is one bit) and
   grants authority over exactly that one project — no admin, no user
   identity, no other projects.

## Outbound: mount your app as `itx.<name>`

1. **Expose a Cap'n Web WebSocket endpoint** in your app and verify a bearer
   token on the upgrade. No platform code required:

   ```ts
   // Plain node example; on Workers use newWorkersWebSocketRpcResponse.
   import { RpcTarget, newWebSocketRpcSession } from "@iterate-com/capnweb";
   import { WebSocketServer } from "ws";

   class TodoApp extends RpcTarget {
     async add(title: string) {
       /* … */
     }
     async list() {
       /* … */
     }
   }

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
     egress: { urls: ["https://my-todos.example"] },
     material: { apiKey: process.env.EGRESS_KEY },
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
         "wss://my-todos.example/api",
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
