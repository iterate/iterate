# The sandbox container image: the STOCK Cloudflare Sandbox runtime, nothing
# baked in. Wrangler requires a Dockerfile per container class, so this
# definition exists to satisfy it; keep it free of package-install layers — the stock image is
# cached on effectively every container host, while any per-account derived
# LAYER is not and puts a cold image pull (observed in MINUTES, hanging every
# sandbox exec in the deployment) on each fresh placement. That is why the
# dynamic-worker build toolchain is NOT installed here: the builder service
# bootstraps its pinned Wrangler, pnpm, and nub once per container life with Bun
# (src/domains/workers/cloudflare-sandbox-build-backend.ts), taxing only builds — never the
# sandboxes that build nothing. Sandboxes are pets (see docs/sandboxes.md):
# anything a workload needs beyond the stock tools (Ubuntu 22.04, Node 20,
# Bun, git, curl, jq, …) is installed inside the sandbox at runtime and
# persists under /workspace via snapshots — not here.
#
# The tag must stay in lockstep with the @cloudflare/sandbox npm version
# (apps/os/package.json) or the SDK logs a version-skew warning.
FROM docker.io/cloudflare/sandbox:0.12.3

# The base image already EXPOSEs 3000 (the SDK control-plane port the Durable
# Object dials for exec/files/etc.); restated for clarity and so miniflare's
# local-dev health-check has an explicit port. Not for app services.
EXPOSE 3000
