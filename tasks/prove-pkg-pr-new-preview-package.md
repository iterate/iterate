---
status: in-progress
size: small
disposition: throwaway-pr
---

# Prove preview projects install the PR's `iterate` package

Status: Specification complete. Implementation and deployed-preview verification remain.

- [ ] Add a dependency-free marker function under a non-virtual `iterate` package export.
- [ ] Import the marker from the seeded project worker and render its value on the project homepage.
- [ ] Publish a draft PR with the `preview` label so the branch package and OS preview deploy.
- [ ] Create a project on the preview and visibly confirm its homepage renders the marker.

## Scope

This is a disposable integration proof and will be closed without merging. It deliberately imports a non-virtual package subpath: `iterate/sdk` is embedded into dynamic worker builds by OS, so using it would not prove that the seeded repo installed the PR's `pkg.pr.new` package.

## Implementation log

- 2026-07-21: Chose a new `iterate/preview-proof` subpath so a successful project build requires package installation and export resolution from the exact PR-head tarball.
