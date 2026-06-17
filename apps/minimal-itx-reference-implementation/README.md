# minimal-itx-reference-implementation

A single, minimal, coherent reference implementation of **itx** — Iterate's
capability layer over Cap'n Web. A context is the fold of a durable event log,
served over Cap'n Web against real workerd + a real `Stream` Durable Object.

Read **[DESIGN.md](./DESIGN.md)** for the model and the file map.

## Run

```bash
pnpm install
npm run typecheck        # tsc --noEmit
npm run dev              # terminal 1: wrangler dev (real workerd) on :8788
npm test                 # terminal 2: the vitest e2e suite (node + browser)
```

Like `apps/os`, the suite never starts a server — it points at one that is
already running. `npm test` needs `npm run dev` up (or set `ITX_BASE` /
`APP_CONFIG_BASE_URL` to a deployed worker). It is a two-project vitest config:

- **node** (`itx.e2e.test.ts`) — every core concept through a naked Cap'n Web
  stub, then the catalogue (`examples.ts`) across every server-side runtime
  (node, cli, post-script, dynamic-worker).
- **browser** (`itx.browser.test.ts`) — the browser leg of the same matrix, in
  a real Chromium tab via Playwright.

Together they exercise, end to end: live capabilities, dynamic workers, a
repo-backed dynamic Durable Object facet from `counter.js`, host runtime
built-ins, deep dotted paths + longest-prefix shadowing, agent inheritance from
its project, cross-project isolation, the admin-only platform root, auth at the
connect door, and codemode.

Run one project with `npm test -- --project node` (or `--project browser`).

## Connect

```ts
import { withItx } from "./client.ts";

using itx = withItx({ projectId: "shared", path: "/", token: "alice-token" });
await itx.provideCapability({ path: ["greeter"], capability: (n) => `hi ${n}` });
await itx.greeter("alice"); // "hi alice" — naked deep path, no client path proxy
```

The root ITX control names (`provideCapability`, `invokeCapability`,
`revokeCapability`, `describe`) cannot be mounted as user capabilities. Script
execution is intentionally HTTP-only: use `POST /api/itx/<projectId>` rather
than `itx.runScript()` over the WebSocket model.

`withItx` also normalizes raw local SDK objects at provide time. Bare Cap'n Web
cannot serialize arbitrary class instances such as `new Slack.WebClient()` by
value; the client keeps the object local and exposes one live
`invokeCapability({ path, args })` provider for it:

```ts
const slack = new Slack.WebClient(process.env.SLACK_TOKEN);
await itx.provideCapability({ path: ["slack"], capability: slack });
await itx.slack.chat.postMessage({ channel: "C123", text: "hi" });
```

The public connect shape is `/api/itx` for the admin platform root and
`/api/itx/<projectId>` for a project. There is no public agent connect endpoint:
get an agent's ITX through the project-local agents capability:

```ts
using project = withItx({ projectId: "shared", token: "alice-token" });
const agent = project.agents.get("/agents/alice");
await agent.itx().whoami();
```

There is no global project context — a project is the top of its own chain.
Cross-project listing and the platform (`__null__`) streams live behind the
**admin-only** root ([root-itx.ts](./root-itx.ts)):

```ts
import { withRoot } from "./client.ts";

using root = withRoot({ token: "root-token" }); // an admin (access: "all")
await root.projects.list();
const log = root.streams.get("/integrations/slack/webhooks"); // pre-scoped to __null__
await log.append({ type: "events.iterate.com/test/webhook", payload: { hi: 1 } });
```

## Curl

`POST` runs a script against the same selected context and records
`script-execution-requested` / `script-execution-completed` in the folded state:

```bash
curl -sS \
  -H 'authorization: Bearer alice-token' \
  -H 'content-type: text/plain' \
  --data 'async () => "hello from curl"' \
  'http://127.0.0.1:8788/api/itx/shared'
```
