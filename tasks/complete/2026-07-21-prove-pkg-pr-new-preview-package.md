---
status: complete
size: small
disposition: throwaway-pr
---

# Prove preview projects install the PR's `iterate` package

Status: Complete. A small patch teaches worker-bundler to install direct HTTP(S) tarballs; a fresh preview project now renders the marker exported by the exact PR-head pkg.pr.new package.

- [x] Add a dependency-free marker function under a non-virtual `iterate` package export. *Added the PR-specific marker to the existing root `iterate` entrypoint.*
- [x] Import the marker from the seeded project worker and render its value on the project homepage. *The real import is retained so a fresh project visibly fails instead of weakening the proof to manifest rendering.*
- [x] Publish a draft PR with the `preview` label so the branch package and OS preview deploy. *Draft PR #2175 is labeled `preview`.*
- [x] Create a project on the preview and check its homepage. *`pkg-proof-patched-2175.iterate-preview-2.app` returns HTTP 200 with the branch-only marker.*

## Scope

This is a disposable integration proof and will be closed without merging. It deliberately retains a non-virtual package import because `iterate/sdk` is embedded by OS; a successful homepage is only possible if the branch tarball is actually installed.

## Implementation log

- 2026-07-21: Chose a new `iterate/preview-proof` subpath so a successful project build requires package installation and export resolution from the exact PR-head tarball.
- 2026-07-21: Package build and typecheck pass locally; regenerated the canonical seeded-repo file map.
- 2026-07-21: First preview project reached the branch template but failed with `No such module "iterate/preview-proof"`: the worker bundler only installs runtime dependencies. Moved the throwaway seed's `iterate` spec from `devDependencies` to `dependencies` so the homepage is a real installation proof.
- 2026-07-21: The runtime-dependency experiment failed identically because worker-bundler resolves only semver ranges through npm registry metadata; pkg.pr.new serves a direct tarball and no compatible registry endpoint.
- 2026-07-21: A manifest-rendering fallback was deployed, but reviewer feedback correctly identified that it did not exercise `pkgPrNewPreviewProof` and therefore did not satisfy the requested proof. Reverted to the real import and reclassified the result as a regression exposed by PR #2144.
- 2026-07-21: Patched worker-bundler's readable published installer chunk to recognize HTTP(S) dependency specs, extract and validate their package metadata, and install their transitive dependencies through the existing path. Moved the marker onto the root `iterate` entrypoint to avoid a throwaway export.
- 2026-07-21: After pkg.pr.new published commit `58ac700`, a freshly created preview project returned HTTP 200 and rendered `Hello from PR #2175's pkg.pr.new iterate package.`
