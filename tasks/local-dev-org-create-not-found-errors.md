---
state: backlog
priority: low
size: small
dependsOn: []
---

# Local dev: NOT_FOUND errors right after org creation on empty DB

Observed in `apps/os` local dev on a fresh/empty DB:

- Create organization succeeds
- App redirects into org flow
- Immediately logs 4 tRPC NOT_FOUND errors (on initial load/redirect):
  - `TRPC Error 404 in project.bySlug`
  - `TRPC Error 404 in machine.list`
  - `Project with slug <org-slug> not found`

Notes:

- Repro seen at `https://dev-jonas-os.dev.iterate.com/orgs/nustom`
- This happens before any project is created
- Looks like an early project-scoped query/redirect using org slug as project slug in this window
- Example logs: `@/Users/jonastemplestein/.cursor/projects/Users-jonastemplestein-superset-worktrees-iterate-bla-bla/terminals/5.txt:180-266`
