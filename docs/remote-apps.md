# Remote apps: independently deployed web apps behind your project

A web app deployed anywhere — its own workers.dev, a VPS, a laptop — can serve
your project without holding any credential of its own. The model:

- The app is a **stateless vessel**. It stores no secrets, no sessions, no
  pairing. Every useful request reaches it through your project.
- Your project's config worker is the **front door**, serving the app on a
  project host like `tasks--<slug>.iterate.app`: it authenticates the browser
  with the platform's project-member gate, then reverse-proxies everything —
  pages, assets, and WebSocket upgrades — to the vessel.
- The browser's short-lived session token travels with each forwarded
  request, and the vessel presents it back to `os.iterate.com/api` to act
  **as that user on that project**. Commits, events, and audit trails carry
  the real human.

Trust is declared in code: the proxy lines you commit to `/repos/config` are
the whole integration. Delete them and the app knows nothing.

## The front door: a few lines in your config worker

```ts
// worker.ts in /repos/config — the "tasks" app branch.
if (app === "tasks") {
  // (a) Platform auth: login redirect for strangers, denial for
  // non-members, null for a current project member. Local token
  // verification — no per-request auth-worker hop.
  const denied = await itx.auth.get({ policy: "project-member" }).fetch(request);
  if (denied) return denied;

  // (b) Transparent proxy to the externally deployed vessel. The platform
  // ingress already stamped x-itx-project-id; the user's session rides the
  // iterate-project-auth cookie. HTTP responses and WebSocket 101s both
  // tunnel straight through.
  const url = new URL(request.url);
  url.protocol = "https:";
  url.host = "tasks.iterate.workers.dev";
  return fetch(
    new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    }),
  );
}
```

Commit that and `https://tasks--<slug>.iterate.app` works: sign-in is the
platform's own flow, membership is checked against the real directory, and
the vessel never sees an unauthenticated request.

## The vessel: what the app does with a forwarded request

1. Read `x-itx-project-id` (stamped by platform ingress) and the
   `iterate-project-auth` cookie (the short-lived project-host session token
   the auth worker minted at login — 15-minute TTL, refreshed transparently).
2. On each `/api` WebSocket connection, dial the platform back and present
   the token:

   ```ts
   import { newWebSocketRpcSession } from "capnweb";
   import type { UnauthenticatedOs } from "iterate/client";

   const os = newWebSocketRpcSession<UnauthenticatedOs>("wss://os.iterate.com/api");
   using session = os.authenticate({ type: "project-app-session", token });
   using project = session.projects.get(projectId);
   // The user's authority on exactly this project: repos, streams, agents, …
   ```

3. Serve the UI from whatever paths reach it — relative URLs keep everything
   on the proxied origin, so the app needs zero awareness of the proxy.

The token is verified locally at the `/api` door (an HS256 check against the
secret shared between the auth and os workers — no auth-worker hop);
membership was checked when the token was minted, and its expiry bounds
revocation lag. A leaked token impersonates one user on one project for
minutes, not a project forever.

The reference vessel is [iterate/tasks](https://github.com/iterate/tasks): a
Kanban board over `/repos/config`'s `tasks/` folder — one ephemeral Durable
Object per project fanning out live state, every board action a `commitFiles`
attributed to the connected user, nothing stored.

## The machine lane: headless apps as the project itself

A server-side app with no user in the loop (a cron, a bot, an integration)
authenticates as the **project** instead, with the API key every project is
born with:

1. Reveal it once — dashboard → `/secrets` → `project-api-key` → Reveal, or
   `itx.secrets.get("/secrets/project-api-key").reveal()`. The born key is
   created `visibility: "readable"` (an immutable birth-certificate fact) and
   is structurally barred from egress substitution — it exists only to be
   verified against, inside the project's Secret Durable Object.
2. Connect:

   ```ts
   import { connectItx } from "iterate/node";

   using project = connectItx({
     baseUrl: "https://os.iterate.com",
     auth: { type: "project-secret", projectId: "prj_…", secret: apiKey },
     projectId: "prj_…",
   });
   ```

Treat that key as the project's root credential: prefer the user lane
wherever a human is present, and rotate the key with an ordinary
`update({ egress: { urls: [] }, material: newValue })` if it ever leaks.

## Developing your app against a live project

The proxy target is just a hostname your config worker computes, which makes
"run the vessel on my laptop, use it with my production project" a two-piece
trick: a tunnel, and a knob.

**The tunnel** is captun (`apps/tunnels`, `tunnels.iterate.com`) — public
local URLs that forward HTTP _and_ WebSockets, packaged as a Vite plugin:

```ts
// vite.config.ts of your app
import captunVite from "captun/vite";
export default defineConfig({ plugins: [captunVite() /* … */] });
```

```bash
CAPTUN_TUNNEL_NAME=jonas-tasks CAPTUN_TOKEN=… pnpm dev
# → https://jonas-tasks.tunnels.iterate.com → localhost:5173, HMR included
```

**The knob** is `itx.kv` — the small durable project key-value store
(Workers KV, project-scoped, no Durable Object in the read path, so the
config worker can consult it on every request for microseconds). Make the
proxy target dynamic with prod as the fallback:

```ts
const target =
  ((await itx.kv.get("tasks-app-origin")) as string | null) ?? "tasks.iterate.workers.dev";
url.host = target;
```

Flip to your laptop and back with one CLI call — no commit, no rebuild:

```bash
pnpm cli itx run --context prj_… -e 'await itx.kv.set("tasks-app-origin", "jonas-tasks.tunnels.iterate.com")'
pnpm cli itx run --context prj_… -e 'await itx.kv.delete("tasks-app-origin")'
```

Better still, **route per-user**: the gate already knows who the member is,
so production can send only you to your laptop while everyone else stays on
the deployed app — live development against real data with zero blast
radius:

```ts
const actor = await itx.auth
  .get({ policy: "project-member" })
  .authenticate(req, { type: "from-server-cookie" });
const devOrigin =
  actor.userId === MY_USER_ID ? await itx.kv.get(`dev-origin:${actor.userId}`) : null;
url.host = (devOrigin as string | null) ?? "tasks.iterate.workers.dev";
```

The security posture is unchanged: the tunnel URL is public but the vessel
is credential-free, so direct hits see only the landing page — board data
exists only for requests the proxy stamped with a valid platform token. Your
local vessel will make **real commits to the real repo** as you; that is the
point, but know it. KV is eventually consistent across the edge (writes are
immediate where written, global within ~60s) — the right trade for a routing
knob, the wrong one for anything that is data.

## Current semantics and limits

- **Proxy hops**: browser traffic pays ingress → config worker → vessel.
  Request bodies stream through except when a project egress `hold` rule
  parks a request for human approval (buffering there is what makes
  approve-then-send possible).
- **Whole-project authority** on the machine lane; per-user authority on the
  session lane. Scoped machine tokens are future work.
- **Membership staleness**: removing someone from a project takes effect at
  token expiry (≤15 minutes) on proxied apps, because verification is local.
  The mint side always re-checks membership live.

Proofs: `apps/os/e2e/vitest/remote-apps.e2e.test.ts` exercises both credential
lanes at the `/api` door, including confinement and expiry.
