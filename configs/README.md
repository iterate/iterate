# Project config repository templates

Each child directory is a complete project config repository:

- `default/` is embedded into the OS worker at build time and remains the
  project-creation default.
- `with-voice/` is a small alternate template used to prove public GitHub
  template creation end to end.
- `codemode-tag/` is the `<codemode status="...">` response-format
  experiment: its worker retargets agents to the platform's headless
  processor and interprets assistant output itself (see its README).

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
