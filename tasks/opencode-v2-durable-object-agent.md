---
status: in-progress
size: medium
tags: [os, dynamic-workers, config-templates, opencode, poc]
branch: opencode-v2-poc
---

# opencode v2 as a userland Durable Object agent (POC)

## Status summary

Working locally (2026-09-21). opencode v2 boots inside a userland Durable
Object of a project born from the new `configs/opencode` template, answers
`itx.worker.opencode.prompt({ text })` with GPT-5.4 replies, keeps session
history across prompts, and gets its API key through the platform's secret
cell with zero core changes. Remaining: preview deploy + browser demo of the
app host (local dev has no app hostnames).

Core changes needed: none. Two userland workarounds were needed, both
recorded in the log: the opencode dependency tree must be prebundled (the
platform bundler cannot install/resolve it), and Worker Loader modules have
no `import.meta.url`.

## Ask (verbatim gist)

> See if you can incorporate opencode v2: it runs on durable objects, so
> maybe set up a project which swaps out the agent implementation with
> opencode — or, if that's complex/a bad idea, run opencode as a proxyable
> "agent" callable via some capability you add (ideally entirely in
> userland; surgical core changes OK). Presumably it's runnable in one of
> our userland DO facets. POC: simplicity over edge cases. More than
> anything: proof that our system has the required parts, or what's the
> minimal amount we need to add to core.

## What opencode v2 gives us (researched)

- `@opencode/sdk@2.0.12` exports `./workerd`: `OpenCodeWorkerd.create({
  storage: DurableObjectStorage, config, plugins })` boots the whole
  opencode server in-process inside a Durable Object, database on the
  object's SQLite, filesystem/process/pty services replaced by inert stubs.
  Returns the typed client (`sessions.create`, `sessions.prompt`,
  `events.subscribe`, ...). Docs: https://opencode.ai/v2/docs/build/sdk/cloudflare/
- Requires bundling with the `workerd` package condition and
  `nodejs_compat` (our dynamic workers already have the flag; the bundler's
  public `conditions` option is exposed).
- Credentials: v2 config is `providers.<id>.settings` (package-specific,
  anthropic accepts `apiKey`) and `providers.<id>.headers` (added to every
  request). No env vars needed.
- Size: 394 npm packages, 451MB installed, 13MB minified single-file
  bundle, 2.9MB gzipped. Effect alone is 10MB of source.

## Decisions

1. **Shape: proxyable agent, not a replacement of the platform agent.**
   A stateful dynamic worker (`IterateDurableObject` subclass) hosts one
   opencode instance per Durable Object. It is reached two ways, both
   already supported by the platform:
   - capability tree: `itx.worker.opencode.prompt({ text, sessionID? })`
     (a getter on the project worker that dials
     `itx.workers.get(OPENCODE_REF)`), so platform agents' codemode scripts
     and the itx CLI can delegate to it;
   - fetch lane: app host `opencode--<slug>.<base>` (project-member auth)
     serving a tiny chat page + JSON endpoints, so a human can try it.
   Swapping the platform agent's brain (`deps.callLlm` in core) was
   rejected for the POC: opencode owns its own sessions/messages/tools, so
   "swap the LLM call" would throw away the parts worth proving.
2. **Entirely userland: a new config template `configs/opencode/`.**
   No core changes planned. Files: `worker.ts`, `apps/opencode/opencode.ts`
   (the DO), `package.json`, `tsconfig.json` (root + apps/opencode),
   `README.md`.
3. **API key via the existing secret cell.** Project secret at
   `/secrets/anthropic-api-key`, egress pinned to `https://api.anthropic.com`.
   opencode config sets
   `providers.anthropic.settings.apiKey = 'getSecret("/secrets/anthropic-api-key")'`;
   the ai-sdk provider puts it in `x-api-key`, the dynamic worker's global
   fetch is the project egress door, which substitutes the placeholder.
   The worker creates the (empty) secret on `project/created`; the app's
   root page shows an `itx.secrets.collectFromUser` link until material is
   present. Alternative considered: a platform API key row for anthropic in
   `platform-secrets.ts` (5-line core change) — deferred; the userland path
   proves more.
4. **Model:** `anthropic/claude-sonnet-4-5` (whatever the bundled
   models.dev snapshot names it; verify at runtime). `models.fetch: false`
   so boot does no network.
5. **Bundling plan (the known risk).** Plan A: template `package.json`
   depends on `@opencode/sdk` directly and the platform bundler installs it.
   Expected to fail: the worker-bundler sidecar installs the whole
   transitive tree into an in-memory FileSystem inside a 128MB isolate.
   Plan B if A fails: prebundle `@opencode/sdk/workerd` with esbuild
   (`--conditions=workerd --platform=node --minify`) into
   `configs/opencode/vendor/opencode-workerd.js` (+ `.d.ts`), committed on
   this branch, imported relatively. Record which plan the evidence picked,
   and what core change would remove the workaround (a prebuilt-module
   source for dynamic workers, or a pkg.pr.new-published prebundled
   package).
6. **No PR.** Push the branch; proposed PR body at the end of each commit
   message; reply with the compare link. Deploy to a manually leased
   preview slot for the demo.

## Checklist

- [x] task file committed in isolation _(74290cf27)_
- [x] `configs/opencode/` template: worker.ts, apps/opencode/opencode.ts, package.json, tsconfigs, README _(plus `vendor/` — see log)_
- [x] DO boots `OpenCodeWorkerd.create` on the facet's own SQLite storage; `prompt`/`sessions`/`messages` RPC methods _(`health` too; `apps/opencode/opencode.ts`)_
- [x] project worker: `opencode` getter (capability tree) + `x-iterate-app: opencode` fetch route (project-member auth) _(`worker.ts`)_
- [x] ~~secret bootstrap on `project/created`~~; collect link on the app root page _(`collectFromUser` creates the secret itself on submit, so no bootstrap event handler; the app root page mints the link while `hasMaterial` is false)_
- [x] local proof: project created from the template on `pnpm dev`, one prompt round-trips through opencode → egress → ~~anthropic~~ OpenAI _(switched provider: the platform has no Anthropic key in any Doppler config, only an invalid one in dev; OpenAI is what the platform itself uses)_
- [x] bundling evidence: Plan A outcome recorded; Plan B applied _(see log)_
- [ ] preview deploy on a manually leased slot; demo project; link + screenshot in the final commit message
- [x] lint/typecheck/knip green _(oxlint + oxfmt on the template, `typecheck:template`, `pnpm knip`; the vendored bundle is in both lint ignore lists)_
- [x] README in the template + this task's implementation log: what core lacked, if anything _(nothing; two userland workarounds)_

## Out of scope (follow-ups)

- Mounting opencode's full HTTP API on the app host so `opencode --server
  <url>` attaches from the CLI (needs the raw fetch handler the promise SDK
  hides, plus non-cookie auth).
- Tools: opencode in workerd has no filesystem/shell; giving it itx-backed
  tools via `@opencode/plugin` (`ctx.tool`) is the interesting next step.
- Streaming assistant output into the OS agent feed / stream events.

## Implementation log

All on a local `pnpm dev` (test project `oc`, `prj_6cafa8cee4e44a98adca71f89e5408d8`),
files pushed into the project repo with `itx.repos.get("/repos/config").commitFiles`
via `pnpm cli itx run --file`.

**Plan A (npm dependency) fails in the platform bundler — not on memory,
on resolution.** With `"@opencode/sdk": "2.0.12"` in the template's
package.json, the worker-bundler sidecar installed the tree in ~25s (no
OOM), then esbuild failed:
`node-fetch/src/index.js: No matching export in "fetch-blob/index.js" for import "File"`
(×5) — the installer lays out a flat `node_modules`, so two packages that
pin different `fetch-blob` majors get one of them; and its own resolver
does not honour the `workerd` export condition, so node-only variants of
`@opencode/core` chunks were pulled in (hundreds of `Failed to resolve
'path'/'fs'/...` warnings for chunks the workerd build never touches). This
is the platform gap, if there is one: **the dynamic-worker installer cannot
handle a real dependency tree with conflicting transitive pins or
condition-gated exports.** (Related: tasks/2026-09-08-tarball-transitive-dependencies.md.)

**Plan B (prebundled) works.** `esbuild entry.ts --bundle --minify
--format=esm --platform=node --main-fields=module,main --conditions=workerd
--external:cloudflare:*` → 12.7MB / 2.9MB gzipped, committed as
`configs/opencode/vendor/opencode-workerd.js`. The platform builds the
13MB file into the facet artifact and loads it in ~8s (repo commit of the
13MB file: 5s). Three startup fixes, each found by one round-trip:

1. `Dynamic require of "node:fs" is not supported` — CJS deps inside an ESM
   bundle. Banner: `import { createRequire } from "node:module"; const require = createRequire(...)`.
2. `createRequire`: `import.meta.url` is **undefined in Worker Loader
   modules**; pass a literal absolute path instead.
3. `No such module "impl/format"` — `--platform=node` defaults main-fields
   to `main,module`, picking jsonc-parser's UMD build whose `require`
   branch now fires; `--main-fields=module,main` fixes it.
4. (mine) Worker Loader rejects non-class exports from the entry module
   (`Incorrect type for map entry 'ANTHROPIC_ORIGIN'`); constants went
   module-private.
5. `@opencode/client` 2.0.12 has `server.info()`, not the `health.get()`
   the docs show.

**The credential path works exactly as designed.** First prompt without a
secret: opencode reported `provider.transport: secret has not been
created: /secrets/anthropic-api-key` — the egress door refused the
placeholder, the error rode back through opencode's session. After
`itx.secrets.get(path).create({ egress, material })`: the secret's audit
showed `usedCount: 1, lastUsedUrl: https://api.anthropic.com/v1/messages`
and Anthropic answered 401 — the dev Doppler `ANTHROPIC_API_KEY` is
invalid (401 from curl too; no other config has one). Switched to
`openai/gpt-5.4` + `/secrets/openai-api-key`; reply: "Hi there, hope you're
doing well!" (9.3s wall clock for the CLI round trip). Follow-up in the
same session recalled "teal". `sessions()` lists them.

**Timing.** Warm `prompt` round trip from the CLI: 5–10s. The facet's
`blockConcurrencyWhile` boot is inside that on a cold object.

**Not done / follow-ups** (beyond the out-of-scope list above): the
`worker-updated` warm-up calls `health()` on every config commit — cheap,
but it means the object boots on deploy; drop it if that ever matters.
