---
status: complete
size: small
disposition: throwaway-pr
---

# Prove preview projects install the PR's `iterate` package

Status: Complete with a negative result. The preview substitutes the exact PR-head pkg.pr.new URL, but seeded workers no longer install it after the container builder was replaced by worker-bundler in PR #2144.

- [x] Add a dependency-free marker function under a non-virtual `iterate` package export. *Added `iterate/preview-proof`, returning a PR-specific marker.*
- [x] Import the marker from the seeded project worker and render its value on the project homepage. *The real import is retained so a fresh project visibly fails instead of weakening the proof to manifest rendering.*
- [x] Publish a draft PR with the `preview` label so the branch package and OS preview deploy. *Draft PR #2175 is labeled `preview`.*
- [x] Create a project on the preview and check its homepage. *The marker import fails with `No such module "iterate/preview-proof"`, disproving runtime installation.*

## Scope

This is a disposable integration proof and will be closed without merging. It deliberately retains a non-virtual package import because `iterate/sdk` is embedded by OS; a successful homepage is only possible if the branch tarball is actually installed.

## Implementation log

- 2026-07-21: Chose a new `iterate/preview-proof` subpath so a successful project build requires package installation and export resolution from the exact PR-head tarball.
- 2026-07-21: Package build and typecheck pass locally; regenerated the canonical seeded-repo file map.
- 2026-07-21: First preview project reached the branch template but failed with `No such module "iterate/preview-proof"`: the worker bundler only installs runtime dependencies. Moved the throwaway seed's `iterate` spec from `devDependencies` to `dependencies` so the homepage is a real installation proof.
- 2026-07-21: The runtime-dependency experiment failed identically because worker-bundler resolves only semver ranges through npm registry metadata; pkg.pr.new serves a direct tarball and no compatible registry endpoint.
- 2026-07-21: A manifest-rendering fallback was deployed, but reviewer feedback correctly identified that it did not exercise `pkgPrNewPreviewProof` and therefore did not satisfy the requested proof. Reverted to the real import and reclassified the result as a regression exposed by PR #2144.
