# Project config repository templates

Each child directory is a complete project config repository:

- `default/` is embedded into the OS worker at build time and remains the
  project-creation default.
- `with-voice/` is a small alternate template used to prove public GitHub
  template creation end to end.

Every template root, and every direct child under its optional `apps/`
directory, must contain a `tsconfig.json`; the OS typecheck validates all of
them against the current workspace packages.

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
that agent on connected browser clients. Both checked-in templates demonstrate
the pattern with different `ONBOARDING.md` prompts; a template without that
event case has no onboarding agent or redirect.
