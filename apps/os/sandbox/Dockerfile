# The sandbox container image: the STOCK Cloudflare Sandbox runtime plus the
# pinned dynamic-worker build toolchain. Keep it lean — a small image is what
# keeps sandbox deploys fast and cold-host image pulls short. Sandboxes are
# pets (see docs/sandboxes.md): anything a workload needs beyond the stock
# tools (Ubuntu 22.04, Node 20, Bun, git, curl, jq, …) is installed inside the
# sandbox at runtime and persists under /workspace via snapshots — not here.
#
# The tag must stay in lockstep with the @cloudflare/sandbox npm version
# (apps/os/package.json) or the SDK logs a version-skew warning.
FROM docker.io/cloudflare/sandbox:0.12.3

# The dynamic-worker build toolchain (esbuild rides INSIDE wrangler — no
# separate bundler pin). This pin MUST equal WRANGLER_VERSION in
# src/domains/workers/build-recipe.ts: the version is hashed into every build
# key, and local dev builds with apps/os's own wrangler devDependency at the
# same pin — a bump that misses one of the three builds different bytes under
# one key. build-recipe.test.ts asserts the repo side; grep this file on bump.
RUN npm install -g wrangler@4.107.0

# The base image already EXPOSEs 3000 (the SDK control-plane port the Durable
# Object dials for exec/files/etc.); restated for clarity and so miniflare's
# local-dev health-check has an explicit port. Not for app services.
EXPOSE 3000
