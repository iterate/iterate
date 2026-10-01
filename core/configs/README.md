# Core's project templates

Project creation copies a template's files into a new `/repos/config` repository. The project owns
that copy: later template changes never overwrite it. Every build of core offers these templates,
and each depends on nothing outside core, so they are also the plainest examples of how a project
is configured.

- `default/` — the homepage, the agents app, and inbound email handed to agents. `agents.ts`
  re-exports the agents app's two classes from `iterate/agents`; the init case of `worker.ts`
  (`project/worker-updated`) calls `installAgents(itx)`, which names that module of the published
  config, so a commit that doesn't change it leaves the agents running; its `email/received` case
  gives each email thread from a member an agent of its own. It sets no schedule: an idle project
  sleeps. Its init case holds a heartbeat, commented out: uncommented, a schedule that appends
  `heartbeat` on `/` every five minutes and wakes the project each time. The dash and the consent
  page start a person's project from this one.
- `minimal/` — the homepage and an empty `processEvent`: no agents, no schedules. A creation that
  names no template gets this one.

A template's `package.json` names its main module in `"main"` (`worker.ts` in each). It and the
files it imports may be TypeScript or JavaScript, and import packages by name: `iterate/*` and
`zod` come from the platform, any other package from npm as listed in `dependencies` (these list
none). The worker extends `IterateConfigEntrypoint` from `iterate/sdk`, whose docstrings say what
its `fetch` and `processEvent` are handed; each template's `AGENTS.md` says what its own do.

Templates are type-checkable as they stand: `package.json` lists the SDK's types from
`https://pkg.pr.new/iterate/iterate/iterate@main`, `@cloudflare/workers-types` and `typescript` as
devDependencies, so `npm install && npx tsc` checks a project's checkout, while the loader links
the running platform's SDK (an `iterate` absent from `dependencies` is the platform's).
`devDependencies` are copied as written. In iterate's repo, `pnpm typecheck:configs` checks every
template against the workspace packages.

The build (`os/scripts/build.ts`) lists each one under its GitHub reference at the checkout's
commit, in the repository the checkout's `origin` names
(`github:iterate/core#<sha>&path:core/configs/default` in a clone of iterate/core), and a creation
naming that reference is seeded from the build's copy, with no GitHub request.
`session.projects.templates()` lists them, `default/` first, then any template the build was given
with `--template`. The build fails without `default/`.
`projects.create({ project, configRepoTemplate })` also accepts custom references such as
`github:owner/repo#main&path:templates/example`; the API resolves the ref to a commit before
persisting the creation request.
