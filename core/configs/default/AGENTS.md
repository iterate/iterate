# Project configuration

This repository is the project's code. A commit to `main` publishes it: the platform loads
`worker.ts`, the `main` in `package.json`, and every context of the project runs the new code.

`worker.ts` extends `IterateConfigEntrypoint` from `iterate/sdk`, which holds the hosts (a
processor imports `StreamProcessor` and `defineProcessorContract` from `iterate/stream/processor`):

- `processEvent({ event, itx })` sees every durable event of every context of the project, one at
  a time, in no particular order and at least once, so each case must be idempotent. `itx` is the
  project's root; `itx.cd(event.path)` is the event's own context. Keep no state in the worker:
  read it from the project.
  - The `events.iterate.com/project/worker-updated` case is the init hook. It runs after every
    published commit: it installs the agents and voice apps. The project sets no schedule, so an
    idle project sleeps (the `heartbeat` template shows one that wakes it every five minutes).
  - The `events.iterate.com/email/received` case hands each email a member sends to the project
    to an agent of its own per thread, `/agents/email/t<thread>`, once the `email` facet has
    folded it into its thread; the agent replies with `itx.email.send({ inReplyToOffset })`. An
    agent acts with the project root's full reach: every context, secret-backed call, repository
    and the website. So only the platform's own record of a member's mail sent straight from their
    domain reaches one; a forward, a list's copy, a re-sent old message, an auto-reply or a bounce
    is ignored.
- `fetch` serves every host of the project. The `x-iterate-routing-slug` header names the host
  (`blog` for `blog--<project>`, absent on the apex), so route on it with a plain `if`. A request
  a fetch route takes never reaches it: the platform sends it to the route's target first
  (`iterate tunnel <port>` sets a route per tunnel; `itx.fetchRoutes.set` sets one by hand).

The agents app is the npm package `@iterate-com/agents`. `agents.ts` re-exports its two classes,
and every agent runs from that file's own bundle: a commit that only changes `worker.ts` leaves the
agents running, and pinning another build of the package in `package.json` restarts them on their
next call. A pkg.pr.new build loads only at a full commit (`…/@iterate-com/agents@<sha>`); the
Agents app's **Upgrade to the newest** commits main's newest build.

Voice is the npm package `@iterate-com/voice`, installed the same way beside the agents app, which
every call runs on: `voice.ts` re-exports the `itx.voice` service and each call's relay class, the
init case calls `installVoice(itx)`, and pinning another build restarts voice on its next call. A
call needs the project's OpenAI key (`/secrets/openai`), which Kit and the Voice app ask for; the
Voice app's **Upgrade to the newest** commits main's newest build.

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
