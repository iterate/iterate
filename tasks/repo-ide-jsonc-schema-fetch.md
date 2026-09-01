---
status: ready
size: small
---

# Un-fixme repo-ide-jsonc: stop depending on live schemastore fetches

`specs/repo-ide-jsonc.spec.ts` is parked (fixme, 2026-09-02): the schema-lint
squiggle stopped appearing in CI (4/4 attempts on PR #2567) while everything
else passed. The spec's real dependency is a live browser fetch of the 467KB
tsconfig schema from schemastore.org — and schemastore changed infrastructure
on 2026-09-01 (`json.schemastore.org` now 301s to `www.`), so the fetch is
evidently unreliable from CI browsers even though `www.schemastore.org`
serves 200 + CORS from a laptop.

- [ ] un-fixme the spec
- [ ] make the schema source reliable: vendor the handful of well-known
      schemas (tsconfig/jsconfig/package.json/github-workflow/pnpm-workspace,
      see `apps/os/src/components/repo-ide/repo-json-schema.ts`) into the
      repo or serve them from our own origin, with the live schemastore URL
      as a fallback — kills the external dependency for both CI and users
- [ ] confirm the squiggle assertion passes in CI again
