---
status: done
size: medium
---

# OS Captun Worker Test Tunnel

Status summary: Done. Captun exposes `captun/worker` in iterate/captun#14, OS installs the pkg-pr-new build, deploys Captun's Durable Object under `/__iterate/captun`, and the e2e MCP test passes against a real public preview URL.

## Assumptions

- Use the pkg-pr-new package from iterate/captun#14 until `captun/worker` is published.
- Mount Captun under an OS-owned path so e2e tests can create URLs like `https://os.../__iterate/captun/<name>/...`.
- Keep the tunnel client local to the e2e test, but make the MCP server URL a real public URL that Workers can fetch over the internet.
- Protect tunnel connection setup with the OS admin bearer token when the deployment has one configured; forwarded tunnel requests remain addressed by an unguessable test tunnel name.

## Checklist

- [x] Install the Captun PR package in `apps/os`. _Installed `https://pkg.pr.new/captun@14` in `apps/os/package.json` and `pnpm-lock.yaml`._
- [x] Export and bind Captun's Worker Durable Object in the OS Worker stack. _Bound `CaptunServerShard` in `apps/os/alchemy.run.ts` and re-exported it from `apps/os/src/entry.workerd.ts`._
- [x] Add an OS route that rewrites `/__iterate/captun/<name>/...` into Captun's folder routing. _Added `handleCaptunTunnelFetch` before app routing in `apps/os/src/entry.workerd.ts`._
- [x] Update the e2e MCP test to connect a local MCP server through the public OS-hosted Captun tunnel. _Added `createOsCaptunTunnel` and wired the test's MCP server URL through `https://os.../__iterate/captun/<name>/mcp`._
- [x] Remove reliance on the stashed `egressFetch` experiment for that MCP test. _The MCP test now uses `createOsCaptunTunnel`; `egressFetch` remains only for the existing project egress intercept helper._
- [x] Verify typecheck/tests/e2e enough to prove the public-tunnel MCP path works. _Local typecheck/lint/tests passed, GitHub checks passed, and targeted preview e2e passed against `preview_2`._

## Implementation Notes

- 2026-05-22: The earlier uncommitted `egressFetch` threading experiment was stashed as `stash@{0}` before starting this approach.
- 2026-05-22: Captun PR package install command from pkg-pr-new: `npm i https://pkg.pr.new/captun@14`.
- 2026-05-22: Captun PR: https://github.com/iterate/captun/pull/14. Checks passing: `ci`, `autofix`, `publish`, `Continuous Releases`, `Cursor Bugbot`.
- 2026-05-22: OS PR implementation uses the Captun PR package until a published Captun release includes `captun/worker`.
- 2026-05-22: Preview deploy initially exposed a Cloudflare Worker metadata tag limit in Alchemy when adding another Durable Object binding; patched `patches/alchemy@0.83.3.patch` to cap Worker tags at 10.
- 2026-05-22: Verified locally with `pnpm --dir apps/os typecheck`, `pnpm lint`, `pnpm --dir apps/os test`, and `doppler run --config preview_2 -- pnpm e2e -t "third party mcp and call tools"` from `apps/os`.
- 2026-05-22: GitHub checks for iterate#1361 passed: `generate`, `lint-typecheck`, `test`, `autofix`, `scope`, `Preview / deploy`, and `Preview / e2e`.
