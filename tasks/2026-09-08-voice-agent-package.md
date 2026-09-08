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

- **`packages/voice-agent`** (`@iterate-com/voice-agent`, 0.1.0): the sources
  moved with `git mv`; `src/configured-worker.ts` is the tsdown physical
  entry the worker refs name, carrying its whole runtime graph the way the
  github-ai-linter entry does (the SDK's processor machinery, capnweb, yaml
  and zod bundled; only `cloudflare:workers` external), because the dynamic
  worker host installs only a config repo's own dependencies; `src/index.ts`
  is the library entry: worker refs (`voiceAgentEntrypointRef`,
  `voiceAgentFacetRef`, same durable key as before so facet state survives),
  the installer (`installVoiceAgent`, `withVoiceAgentDependency`,
  `legacyGuestPaths`, `removeLegacyGuest`), and the guest's RPC surface as
  plain types (`VoiceAgentRpc`, `SetupVoiceAgentOptions`), which the
  entrypoint class `implements`. The root entry imports nothing: the SDK's
  ref types carry Cloudflare's runtime types, which the mobile app cannot
  compile against, so `ref.ts` spells the shapes locally and `ref.test.ts`
  pins them to the SDK's. Unit tests for the installer and refs live in the
  package; the agent's behavioural tests stay in `apps/os/scripts/voicelab/`
  and import the sources directly.
- **Publishing**: `.github/workflows/pkg-pr-new.yml` builds and publishes the
  package with the other two, so
  `https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@{main,<sha>,<pr>}`
  exist on every push and PR. No platform change: `apps/os/src/pkg-pr-new.ts`
  recognises specs by URL shape, so a deployment pins this package to its own
  ref exactly as it pins `iterate`.
- **`voicelab deploy`** now writes the dependency into the project's
  `package.json` (`--spec` to pin, `--prune-legacy` to delete the committed
  copy); `talk` declares it if absent and never overwrites a pin.
- **Mobile**: `voice-setup.ts` uses the package's installer and refs; the
  embedded copy (`voice-template.generated.ts` and its codegen) is gone.
  Which build a project runs is now the platform's pin rather than the app's
  own copy — a deliberate change, recorded in the code.
- **`configs/voice-agent`** is a two-file template: `package.json` declaring
  the package, and a minimal `worker.ts` with a `/voice/health` route that
  builds and probes the guest (it also proves the package's types resolve
  from a config repo, via the template typecheck).

## Not done here, deliberately

- **Upstream the deployed copies' delta first.** The `say` event and idle
  farewell (~280 lines, contract still 19.0.0) exist only in project config
  repos. Moving those projects onto the package before that delta lands in
  `packages/voice-agent` would downgrade them. Bring it over as its own
  reviewed PR, then run `voicelab deploy --prune-legacy` against `iterate`
  and `templestein`.
- **Preview proof.** Per AGENTS.md, this needs a preview deployment where a
  project whose config repo only declares the package answers `health`,
  `setupVoiceAgent`, and a call, with coherent traces. The package must be
  published (this PR's `@<pr>` ref, or main) before any project can resolve
  it, so the proof runs after the pkg.pr.new job for this branch is green.
- **npm.** pkg.pr.new refs are the version that matters to the platform;
  a tag-triggered `npm publish --provenance` can come later if a registry
  version is wanted.

## Rollout wrinkle

A warm stateful facet keeps the bundle it booted with. `talk` already kills
it after a changed install; a project that upgrades by editing
`package.json` by hand needs the same restart before the new build serves.
