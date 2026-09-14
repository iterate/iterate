---
state: todo
priority: high
size: large
tags: [voice, packages, config-repos, pkg-pr-new]
---

# Publish the voice agent as `@iterate-com/voice-agent`; projects pull it in from package.json

The realtime voice agent (`configs/voice-agent/voice-agent.ts` and its four
siblings, ~325 KB) was installed by `voicelab deploy` and by the mobile app's
embedded copy committing the source files into each project's config repo.
Every project then carried its own copy, and the copies aged separately: on
2026-09-07 the `iterate` and `templestein` projects' copies differed from
each other in comments only, but both were ~280 lines ahead of this repo's
template (a `voice-agent/say` event and an idle farewell that live in no
branch here), and the `iterate` project's copy failed the `iterate` project's
own lint rules.

The packaged starter apps already show the shape that avoids this: a worker
ref names an entry point inside `node_modules`, the config repo contributes
only `package.json`, and the platform builds the guest from the installed
package. This task moves the voice agent to that shape as a second workspace
package next to `@iterate-com/docs`.

## What this change does

- **`packages/voice-agent`** (`@iterate-com/voice-agent`, 0.1.0): an ordinary
  library build with two entries. `./worker` is the agent (the stateless
  entrypoint as default export, `VoiceAgentFacet`), with `iterate` a peer and
  zod a dependency — both external, resolved from the config repo's own
  package.json when the platform builds `voice-agent.ts`. `.` is what a
  project worker, the CLI and the phone import: `VoiceAgentApp` (a partial
  `fetch` for the `voice` app slug, plus `setup` / `remove`), the worker refs
  (which name `voice-agent.ts` in the config repo, as they always did, same
  durable key so facet state survives), the installer, and the guest's RPC
  surface as plain types the entrypoint class `implements`. The root entry
  imports nothing but zod: the SDK's ref types carry Cloudflare's runtime
  types, which the mobile app cannot compile against, so `ref.ts` spells the
  shapes locally and `ref.test.ts` pins them to the SDK's; `app.ts` types the
  project handle structurally like the Docs app's bridge. Declarations come
  from `tsc -p tsconfig.dts.json` (rolldown-plugin-dts's printer crashes on
  function types inside interfaces). Unit tests for the installer, the refs
  and the app live in the package; the agent's behavioural tests stay in
  `apps/os/scripts/voicelab/` and import the sources directly.
- **The install is two dependency lines and a three-line file.** A config
  repo declares the package and zod (the SDK's processor entry leaves zod
  external; every template already declares it) and holds
  `voice-agent.ts` = `export { default, VoiceAgentFacet } from
  "@iterate-com/voice-agent/worker"`. The platform builds that file the way
  it builds worker.ts. The repo holds the agent's name, not a copy; a project
  subclasses in the same file if it needs to. `packages/voice-agent/INSTALL.md`
  says this for an agent making the edit.
- **Publishing**: `.github/workflows/pkg-pr-new.yml` builds and publishes the
  package with the other two, so
  `https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@{main,<sha>,<pr>}`
  exist on every push and PR. No platform change: `apps/os/src/pkg-pr-new.ts`
  recognises specs by URL shape, so a deployment pins this package to its own
  ref exactly as it pins `iterate`.
- **`voicelab deploy`** writes the two files (`--spec` to pin,
  `--prune-legacy` to delete the sources an older deploy committed beside
  voice-agent.ts); `talk` fills gaps if absent and never overwrites a pin or
  a voice-agent.ts holding something else.
- **Mobile**: `voice-setup.ts` uses the package's installer and refs; the
  embedded copy (`voice-template.generated.ts` and its codegen) is gone.
  Which build a project runs is now the platform's pin rather than the app's
  own copy — a deliberate change, recorded in the code.
- **`configs/voice-agent`** is the template version: `package.json`,
  `voice-agent.ts`, and a `worker.ts` that hands the voice app slug to
  `VoiceAgentApp`. The browser client behind that slug is
  `tasks/2026-09-08-voice-web-chat-app.md`; until it exists the slug answers
  501 and says so.

## Not done here, deliberately

- **Upstream the deployed copies' delta first.** The `say` event and idle
  farewell (~280 lines, contract still 19.0.0) exist only in project config
  repos. Moving those projects onto the package before that delta lands in
  `packages/voice-agent` would downgrade them. Bring it over as its own
  reviewed PR, then run `voicelab deploy --prune-legacy` against `iterate`
  and `templestein`.
- **Preview proof.** Done on slot 10 for the first shape (a package-only
  project answered `health` and folded a setup certificate through the
  facet); to be repeated for the re-export shape, since the platform now
  builds `voice-agent.ts` from the repo and resolves the package and zod
  from its package.json. An actual audio call is only covered by the voicelab
  e2e.
- **The SDK's bundling lists.** `packages/iterate` bundles capnweb, sqlfu,
  yaml and zod into its starter-app workers on the ground that the host does
  not install what a tarball dependency declares; the proof above shows it
  resolving capnweb from the `iterate` tarball's own dependencies. Whether
  those lists (and the templates' zod lines) are still needed is
  `tasks/2026-09-08-tarball-transitive-dependencies.md`.
- **npm.** pkg.pr.new refs are the version that matters to the platform;
  a tag-triggered `npm publish --provenance` can come later if a registry
  version is wanted.

## Rollout wrinkle

A warm stateful facet keeps the bundle it booted with. `talk` already kills
it after a changed install; a project that upgrades by editing
`package.json` by hand needs the same restart before the new build serves.
