---
state: draft
priority: medium
size: medium
tags: [os, dynamic-workers, packages, pkg-pr-new]
---

# Re-examine the SDK's bundling lists: the dynamic worker host resolves what a tarball dependency declares

`packages/iterate/tsdown.config.ts` bundles capnweb, sqlfu, yaml and zod
into every starter-app "physical" worker and into the github-ai-linter
entry, on the stated ground that "the dynamic worker host installs the
config repo's dependencies, not transitive dependencies inside iterate's
tarball". Every config template declares `zod` for the same reason, and
`@iterate-com/voice-agent`'s installer writes that line.

Measured on 2026-09-08 (PR #2600, preview slot 10, head a637bda): a config
repo that declared only `iterate`, `@iterate-com/voice-agent` and `zod` had
its `voice-agent.ts` built by the host, and that build reaches
`@iterate-com/capnweb` — through the SDK's `iterate/sdk/capnweb` entry and
the processors keepalive chunk, both of which leave capnweb external — which
the repo does not declare. The guest came up and its facet ran. So the host
did resolve a dependency that only the `iterate` tarball declares, and the
premise behind the bundling lists no longer holds, at least for that case
(`@cloudflare/worker-bundler`'s README says transitive resolution has no
depth limit and installs a flat `node_modules`).

To do:

- Confirm against `apps/os/src/domains/workers/build-backend.ts` and the
  bundler what is installed for a tarball spec, and whether zod would have
  resolved without the template's line (a proof project with no `zod`
  declared).
- If so, delete the `alwaysBundle` / `onlyBundle` machinery in
  `packages/iterate/tsdown.config.ts` (keeping `cloudflare:*` external), the
  `zod` lines in `configs/*/package.json`, and `VOICE_AGENT_ZOD_SPEC` in the
  voice agent's installer; note what the flat node_modules does when two
  packages pin different zod versions.
- If not, record precisely which cases are resolved and which are not, next
  to the lists, so the next package does not have to rediscover it.

Prompted by the review of #2600 (Jonas, 2026-09-08).
