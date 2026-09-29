# Project configuration

This repository is the project's code. A commit to `main` publishes it: the platform loads
`worker.ts`, the `main` in `package.json`, and every context of the project runs the new code.
This project has no agents and no schedules.

`worker.ts` extends `IterateConfigEntrypoint` from `iterate/sdk`:

- `processEvent({ event, itx })` sees every durable event of every context of the project, one at
  a time, in no particular order and at least once, so each reaction must be idempotent. `itx` is
  the project's root; `itx.cd(event.path)` is the event's own context. A case for
  `events.iterate.com/project/worker-updated` runs after every published commit: that is the init
  hook.
- `fetch` serves every host of the project. The `x-iterate-routing-slug` header names the host
  (`blog` for `blog--<project>`, absent on the apex), so route on it with a plain `if`. A request
  a fetch route takes never reaches it: the platform sends it to the route's target first
  (`iterate tunnel <port>` sets a route per tunnel; `itx.fetchRoutes.set` sets one by hand).

`worker.ts` reaches the project through the `itx` that `processEvent` is handed, or through
`using itx = this.getItx()`: when the block ends, the scope, every call made through it and every
handle it awaited are released. Put it in the smallest block that holds its calls, await every
call inside it, and hand data, not handles, out of it; an object that needs reach takes an
accessor, `() => this.getItx()`. Never keep a value from `this.env.ITX.get()`, which nothing
releases: a kept value keeps the project's context, and any facet holding it, resident after the
project goes idle.

Files may be TypeScript or JavaScript and import each other by relative path. Import packages by
name: `iterate/*` and `zod` come from the platform; list any other package in `package.json` and
it loads from npm through esm.sh (packages that need Node.js builtins are refused). Type-check
locally with `npm install && npx tsc`; the loader strips types but never checks them.
