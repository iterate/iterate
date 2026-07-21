---
status: in-progress
size: small
disposition: throwaway-pr
---

# Prove preview projects install the PR's `iterate` package

Status: The first deployed check exposed that runtime bundling ignores `devDependencies`; the proof now declares `iterate` as a runtime dependency and awaits redeploy and homepage verification.

- [x] Add a dependency-free marker function under a non-virtual `iterate` package export. *Added `iterate/preview-proof`, returning a PR-specific marker.*
- [x] Import the marker from the seeded project worker and render its value on the project homepage. *The generated seed now renders the marker in `<strong>` on `/`.*
- [x] Publish a draft PR with the `preview` label so the branch package and OS preview deploy. *Draft PR #2175 is labeled `preview`.*
- [ ] Create a project on the preview and visibly confirm its homepage renders the marker.

## Scope

This is a disposable integration proof and will be closed without merging. It deliberately imports a non-virtual package subpath: `iterate/sdk` is embedded into dynamic worker builds by OS, so using it would not prove that the seeded repo installed the PR's `pkg.pr.new` package.

## Implementation log

- 2026-07-21: Chose a new `iterate/preview-proof` subpath so a successful project build requires package installation and export resolution from the exact PR-head tarball.
- 2026-07-21: Package build and typecheck pass locally; regenerated the canonical seeded-repo file map.
- 2026-07-21: First preview project reached the branch template but failed with `No such module "iterate/preview-proof"`: the worker bundler only installs runtime dependencies. Moved the throwaway seed's `iterate` spec from `devDependencies` to `dependencies` so the homepage is a real installation proof.
