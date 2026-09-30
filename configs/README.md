# Config repository templates

Project creation copies a template's files into a new `/repos/config` repository. The project owns
that copy: later template changes never overwrite it. The public GitHub reference parser and
downloader live in `packages/shared/src/config-repo-template`.

- `default/` — the homepage, the agents and voice apps, and inbound email handed to agents.
  `agents.ts` re-exports the agents app's two classes from the npm package `@iterate-com/agents`,
  and `voice.ts` the voice service and its relay class from `@iterate-com/voice`; the init case of
  `worker.ts` (`project/worker-updated`) calls `installAgents(itx)` and `installVoice(itx)`, which
  name those modules of the published config, so a commit that changes neither leaves both apps
  running; its `email/received` case gives each email thread from a member an agent of its own. It
  sets no schedule: an idle project sleeps.
- `heartbeat/` — `default/` plus a heartbeat its init case sets, a schedule that appends
  `heartbeat` on `/` every five minutes and wakes the project each time.
- `minimal/` — the homepage and an empty `processEvent`: no agents, no schedules.

A template's `package.json` names its main module in `"main"` (`worker.ts` in each). It and the
files it imports may be TypeScript or JavaScript, and import packages by name as listed in
`package.json` (`iterate/*` and `zod` come from the platform). The worker extends
`IterateConfigEntrypoint` from `iterate/sdk`, whose docstrings say what its `fetch` and
`processEvent` are handed; each template's `AGENTS.md` says what its own do.

iterate's deploys, previews and test runs give the platform's build every folder here
(`scripts/os/config-templates.ts`, core/os's `scripts/build.ts` `--template`), with
`@iterate-com/agents` and `@iterate-com/voice` pinned to this checkout's own build
(`scripts/os/published-package-commit.ts`). A creation that names no template gets core's minimal
config instead; the dash and the consent page start a person's project from `default/`. Any other
template may list a pkg.pr.new dependency at a branch (`…@main`): the seed writes it at the commit
pkg.pr.new names for it then, because the loader loads a pkg.pr.new package only at a full commit
(`pinPkgPrNewDependencies` in `core/lib/src/pkg-pr-new.ts`). `devDependencies` are copied as
written.

Templates are type-checkable as they stand: `package.json` lists the SDK's types from
`https://pkg.pr.new/iterate/iterate/iterate@main`, `@cloudflare/workers-types` and `typescript` as
devDependencies, and the packages the worker imports as dependencies, so `npm install && npx tsc`
checks a project's checkout, while the loader links the running platform's SDK (an `iterate` absent
from `dependencies` is the platform's). In this repo, `pnpm typecheck:configs` checks every template
against the workspace packages.

`session.projects.templates()` lists the presets, every folder here. `projects.create({ project,
configRepoTemplate })` also accepts custom references such as
`github:owner/repo#main&path:templates/example`. The API resolves the ref to a commit before
persisting the creation request. Omit it for core's minimal config.

The build lists each preset under a reference at the repository commit, and a creation naming that
reference is seeded from the build's copy, with no GitHub request.
