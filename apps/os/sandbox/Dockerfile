# The sandbox container image: the STOCK Cloudflare Sandbox runtime, nothing
# baked in. Wrangler requires a Dockerfile per container class, so this
# one-liner exists to satisfy it; keep it a one-liner — a lean image is what
# keeps sandbox deploys fast and cold-host image pulls short. Sandboxes are
# pets (see docs/sandboxes.md): anything a workload needs beyond the stock
# tools (Ubuntu 22.04, Node 20, Bun, git, curl, jq, …) is installed inside the
# sandbox at runtime and persists under /workspace via snapshots — not here.
#
# The tag must stay in lockstep with the @cloudflare/sandbox npm version
# (apps/os/package.json) or the SDK logs a version-skew warning.
FROM docker.io/cloudflare/sandbox:0.12.3

# The base image already EXPOSEs 3000 (the SDK control-plane port the Durable
# Object dials for exec/files/etc.); restated for clarity and so miniflare's
# local-dev health-check has an explicit port. Not for app services.
EXPOSE 3000
