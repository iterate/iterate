---
status: complete
size: small
disposition: throwaway-pr
---

# Prove preview projects install the PR's `iterate` package

Status: Complete. A fresh preview project publicly renders the exact PR-head pkg.pr.new URL seeded into its manifest; the experiment also established that worker-bundler cannot runtime-install that tarball URL.

- [x] Add a dependency-free marker function under a non-virtual `iterate` package export. *Added `iterate/preview-proof`, returning a PR-specific marker.*
- [x] ~~Import the marker from the seeded project worker and render its value on the project homepage.~~ *Invalid experiment: worker-bundler only supports registry semver dependencies, while pkg.pr.new supplies a tarball URL.*
- [x] Render the seeded manifest's exact `iterate` dependency URL on the project homepage. *The worker imports its own `package.json` and renders the substituted spec on `/`.*
- [x] Publish a draft PR with the `preview` label so the branch package and OS preview deploy. *Draft PR #2175 is labeled `preview`.*
- [x] Create a project on the preview and visibly confirm its homepage renders the marker. *`pkg-proof4-2175.iterate-preview-2.app` returns 200 and renders the exact final head SHA.*

## Scope

This is a disposable integration proof and will be closed without merging. It first attempted a non-virtual package import because `iterate/sdk` is embedded by OS, then fell back to rendering the seeded manifest after proving worker-bundler cannot install pkg.pr.new tarball URLs.

## Implementation log

- 2026-07-21: Chose a new `iterate/preview-proof` subpath so a successful project build requires package installation and export resolution from the exact PR-head tarball.
- 2026-07-21: Package build and typecheck pass locally; regenerated the canonical seeded-repo file map.
- 2026-07-21: First preview project reached the branch template but failed with `No such module "iterate/preview-proof"`: the worker bundler only installs runtime dependencies. Moved the throwaway seed's `iterate` spec from `devDependencies` to `dependencies` so the homepage is a real installation proof.
- 2026-07-21: The runtime-dependency experiment failed identically because worker-bundler resolves only semver ranges through npm registry metadata; pkg.pr.new serves a direct tarball and no compatible registry endpoint. Reframed the browser proof to render the exact dependency URL from the seeded manifest without overstating runtime installation.
- 2026-07-21: Final head `6b962169e3f8362a86fc67e94e77bac52f9ac3b3` deployed to preview-2. Fresh project `pkg-proof4-2175` returned HTTP 200 and rendered that exact SHA in its pkg.pr.new dependency URL.
