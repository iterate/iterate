# Project configuration with agents

`worker.ts` serves the homepage and installs the agents app on `project/created`, and again
on every commit that changes `agents/`.
It extends `ConfigWorker` from `iterate/sdk`, which holds the hosts (a processor
imports `StreamProcessor` and `defineProcessorContract` from `iterate/stream/processor`),
and reaches the project's `itx`
through `this.withItx((itx) => …)`, or the `itx` that `processEvent({ event, itx })`
is handed; both release everything the call reached when it returns. Never keep
a value from `this.env.ITX.get()`, and answer data, not handles, from `withItx`:
a kept value keeps the project's context, and any facet holding it, resident
after the project goes idle.
The agents app is the npm package `@iterate-com/agents`. `agents/` is the source the
project runs it from: `package.json` pins the package at a commit, `index.ts` re-exports its
two classes. The platform pinned the template's `…/@iterate-com/agents@main` to main's build
when it created the project, and it loads a pkg.pr.new package only at a full commit: to
upgrade, commit a newer one (`…/@iterate-com/agents@<40-hex sha>`, which a HEAD of the `@main`
URL names in `x-commit-key`) in `agents/package.json` and the root's, or use the Agents app's
**Upgrade to the newest**, which commits main's newest build. The app mounts `itx.agents`
through a rewrite rule and owns its catalog and facets. Voice installs the same way:
`@iterate-com/voice` in a `voice/` folder (`installVoice` from `@iterate-com/voice/install`).
Files may be TypeScript or JavaScript and import each other by relative path.
Import packages by name: `iterate/*` and `zod` come from the platform; list any
other package in `package.json` and it loads from npm through esm.sh (packages
that need Node.js builtins are refused).
Edit this repository to customize it; upstream template changes do not replace it.
`worker.ts`'s `fetch` first asks `itx.fetchRoutes.match(request)` and forwards a matched
request to the route's itx expression, `route.target`, with `env.ITX.fetch`
(`iterate tunnel <port>` sets a route per tunnel); keep those lines at the top of `fetch`.
Type-check locally with `npm install && npx tsc`; the loader strips types but never checks them.
