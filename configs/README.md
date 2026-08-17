# Project config repository templates

Each child directory is a complete project config repository:

- `default/` is the first picker choice. It is also embedded into the OS worker
  as the fallback for API callers that omit a template reference.
- `with-voice/` is a small alternate template used to prove public GitHub
  template creation end to end.
- `codemode-tag/` is the `<codemode status="...">` response-format
  experiment: its worker retargets agents to the platform's headless
  processor and interprets assistant output itself (see its README).

Every template root, and every direct child under its optional `apps/`
directory, must contain a `tsconfig.json`; the OS typecheck validates all of
them against the current workspace packages.

The OS project-creation form catalogs every direct child of `configs/` through
Oxlint codegen. Adding a template directory therefore adds it to the same PR's
preview dropdown. Every choice uses its actual GitHub reference, pinned to the
preview's exact commit before it is copied.

Project creation accepts pnpm-style public GitHub references:

```text
github:owner/repo
github:owner/repo#path:path/to/template
github:owner/repo#branch-or-commit&path:path/to/template
git+https://github.com/owner/repo.git#branch-or-commit&path:path/to/template
```

The source ref is resolved once, the selected directory is copied into a new
config repo root commit, and the resulting project is not linked to the source
repository.

Onboarding is a template choice, not an OS feature. A template opts in by
handling the root `project/created` event in `worker.ts`. It can create any
agent shape, append template-local instructions, and use `itx.clients` to open
that agent on connected browser clients. `default` and `with-voice` demonstrate
the pattern with different `ONBOARDING.md` prompts; a template without that
event case, such as `codemode-tag`, has no onboarding agent or redirect.
