---
state: todo
priority: high
size: small
dependsOn: []
tags: [capnweb, publishing, iterate-package, npm]
---

# Publish the capnweb fork so external `iterate` installs get the real client

External npm consumers of the `iterate` package previously resolved
`capnweb: ^0.8.0` to UPSTREAM capnweb (which has 0.8.0–0.10.0 published) —
silently missing the fork's WebSocket-over-RPC support that `iterate/client`
exists to use, plus the repo's pnpm patch (`patches/capnweb@0.8.0.patch`,
server-side `onCall`). PR #2063 pinned the dependency to the GitHub release
tarball as an interim fix, which works but has caveats: no integrity pin, and
registry-only proxies block release-asset URLs.

## What to do

- Publish `@iterate-com/capnweb` (fork + the pnpm patch FOLDED IN) to npm.
- Declare `"capnweb": "npm:@iterate-com/capnweb@<version>"` in
  `packages/iterate/package.json` so `import ... from "capnweb"` keeps working;
  the workspace override still wins in-repo.
- Keep the pnpm-workspace override + patch until the fork release contains
  the patch, then drop the patch.

Scope check done during #2063's audit: `@iterate-com/capnweb` is unclaimed on
npm. Also remember: publishes must go through `pnpm publish` (`pubme.js` was
fixed in #2063 — `npm publish` ignores `publishConfig.exports`).
