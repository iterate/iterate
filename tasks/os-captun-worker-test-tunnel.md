---
status: in-progress
size: medium
---

# OS Captun Worker Test Tunnel

Status summary: Captun package export PR is ready at iterate/captun#14; Iterate integration has not started. The goal is to replace the local egress-fetch MCP experiment with a real public Captun tunnel hosted by the OS Worker.

## Assumptions

- Use the pkg-pr-new package from iterate/captun#14 until `captun/worker` is published.
- Mount Captun under an OS-owned path so e2e tests can create URLs like `https://os.../__iterate/captun/<name>/...`.
- Keep the tunnel client local to the e2e test, but make the MCP server URL a real public URL that Workers can fetch over the internet.
- Protect tunnel connection setup with the OS admin bearer token when the deployment has one configured; forwarded tunnel requests remain addressed by an unguessable test tunnel name.

## Checklist

- [ ] Install the Captun PR package in `apps/os`.
- [ ] Export and bind Captun's Worker Durable Object in the OS Worker stack.
- [ ] Add an OS route that rewrites `/__iterate/captun/<name>/...` into Captun's folder routing.
- [ ] Update the e2e MCP test to connect a local MCP server through the public OS-hosted Captun tunnel.
- [ ] Remove reliance on the stashed `egressFetch` experiment for that MCP test.
- [ ] Verify typecheck/tests/e2e enough to prove the public-tunnel MCP path works.

## Implementation Notes

- 2026-05-22: The earlier uncommitted `egressFetch` threading experiment was stashed as `stash@{0}` before starting this approach.
- 2026-05-22: Captun PR package install command from pkg-pr-new: `npm i https://pkg.pr.new/captun@14`.
