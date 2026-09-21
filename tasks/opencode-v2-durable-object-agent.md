---
status: in-progress
size: medium
tags: [os, dynamic-workers, config-templates, opencode, poc]
branch: opencode-v2-poc
---

# opencode v2 as a userland Durable Object agent (POC)

## Status summary

Not started. Task fleshed out from research on 2026-09-21; decisions below
are best guesses made while Misha was away. Implementation follows in
separate commits on this branch (no PR — review via the compare link).

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

- [ ] task file committed in isolation
- [ ] `configs/opencode/` template: worker.ts, apps/opencode/opencode.ts, package.json, tsconfigs, README
- [ ] DO boots `OpenCodeWorkerd.create` on the facet's own SQLite storage; `prompt`/`sessions`/`messages` RPC methods
- [ ] project worker: `opencode` getter (capability tree) + `x-iterate-app: opencode` fetch route (project-member auth)
- [ ] secret bootstrap on `project/created`; collect link on the app root page
- [ ] local proof: project created from the template on `pnpm dev`, one prompt round-trips through opencode → egress → anthropic
- [ ] bundling evidence: Plan A outcome recorded; Plan B applied if needed
- [ ] preview deploy on a manually leased slot; demo project; link + screenshot in the final commit message
- [ ] lint/typecheck/knip green (`pnpm lint`, `pnpm typecheck`, `pnpm knip`)
- [ ] README in the template + this task's implementation log: what core lacked, if anything

## Out of scope (follow-ups)

- Mounting opencode's full HTTP API on the app host so `opencode --server
  <url>` attaches from the CLI (needs the raw fetch handler the promise SDK
  hides, plus non-cookie auth).
- Tools: opencode in workerd has no filesystem/shell; giving it itx-backed
  tools via `@opencode/plugin` (`ctx.tool`) is the interesting next step.
- Streaming assistant output into the OS agent feed / stream events.

## Implementation log

(appended during implementation)
