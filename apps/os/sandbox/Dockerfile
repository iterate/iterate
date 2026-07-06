# The sandbox container image: the plain Cloudflare Sandbox runtime plus the
# Codex CLI, BAKED IN at build time.
#
# Why baked, not the `-opencode` variant or a runtime install:
#   - the `-opencode` image only ships OpenCode, whose `run` does a ~45s cold
#     bootstrap per invocation — unacceptable;
#   - installing an agent at container start is slow AND unreliable, because a
#     sandbox's egress is intercepted + HTTPS-MITM'd by project policy, so the
#     agents' installers hang or fail at runtime. At BUILD time the network is
#     clean, so baking is both faster (zero per-run install) and reliable.
#
# Cost: codex is a single statically-linked Rust binary (~280MB); npm pulls the
# linux-x64 build only, so there is nothing further to trim. Claude Code is
# intentionally NOT baked yet (it would add another ~240MB self-contained
# binary, and we have no Anthropic key wired to exercise it) — add it the same
# way when needed. The image is pulled once per new instance and cached in
# Cloudflare's registry. See docs/cloudflare-sandboxes.md.
FROM docker.io/cloudflare/sandbox:0.12.3

ENV CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Codex CLI (OpenAI). npm global; its bin lands on the exec shell's PATH
# (/usr/local/bin). Uses OPENAI_API_KEY, injected via the sandbox env-var map
# as a getSecret placeholder and substituted at egress (never in the container).
RUN npm install -g @openai/codex pnpm@10.24.0 && codex --version && pnpm --version

# Default Codex to gpt-5.5 with high reasoning for every sandbox (config.toml is
# read from $HOME/.codex; the exec shell runs as root). A per-call `-m` / `-c`
# still overrides. Verified: a headless gpt-5.5/high turn completes in ~8s.
COPY apps/os/sandbox/root/ /root/

# The warm-up script the sandbox Durable Object runs on the container during
# provisioning (in the background) to log the baked tools in — see
# CloudflareSandboxDurableObject#runWarmup, which references this exact path.
# Kept as its own reviewable asset; extend the script, not the DO, to add setup.
COPY apps/os/sandbox/warmup.sh /opt/iterate/warmup.sh

# Bake the Iterate monorepo with dependencies installed. The actual checkout
# lives outside /workspace so workspace backup/restore cannot hide or strip its
# node_modules; the Durable Object exposes it at
# /workspace/repos/github.com/iterate/iterate with a symlink after restore.
WORKDIR /opt/iterate/iterate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/auth-contract/package.json apps/auth-contract/package.json
COPY apps/auth-example/package.json apps/auth-example/package.json
COPY apps/auth/package.json apps/auth/package.json
COPY apps/iterate-com/package.json apps/iterate-com/package.json
COPY apps/os/package.json apps/os/package.json
COPY apps/semaphore/package.json apps/semaphore/package.json
COPY apps/streams-example-app/package.json apps/streams-example-app/package.json
COPY apps/tunnels/package.json apps/tunnels/package.json
COPY lint/package.json lint/package.json
COPY packages/iterate/package.json packages/iterate/package.json
COPY packages/iterate/bin/ packages/iterate/bin/
COPY packages/mock-http-proxy/package.json packages/mock-http-proxy/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY scripts/package.json scripts/package.json
RUN pnpm install --frozen-lockfile --package-import-method=copy \
  && pnpm_store="$(pnpm store path)" \
  && pnpm store prune \
  && rm -rf "$pnpm_store" /root/.cache /tmp/*
COPY . .

# The base image already EXPOSEs 3000 (the SDK control-plane port the Durable
# Object dials for exec/files/etc.); restated for clarity and so miniflare's
# local-dev health-check has an explicit port. Not for app services.
EXPOSE 3000
