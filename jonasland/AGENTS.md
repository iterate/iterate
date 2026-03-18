# Jonasland

# Most important rules

### Engineering process

- We care MOST about software and API design
- Make us explicitly approve API shapes for publicly used functions
- Similarly, database schemas and zod schemas are super important - we need to get those right early
- Show us what example test code would look like
- Make failing tests first and show them to us
- Work incrementally and make commits along the way - run tests one by one instead of all at once

# Other content

Experimental sandbox infrastructure — container image, networking (caddy egress MITM, iptables, dnsmasq), service registry, and e2e tests.

## Directory layout

- `sandbox/` — Dockerfile, entrypoint (`entry.sh`), pidnap config, home skeleton
- `sandbox/scripts/` — build/dev tooling (build-image, docker-shell)
- `scripts/` — standalone utilities (external-egress-proxy)
- `e2e/` — vitest e2e tests, parameterized across Docker and Fly providers
- `hosts-and-routing.md` — routing model and rationale

## Container image

`sandbox/Dockerfile` builds the jonasland sandbox. Key layers:

- **System packages**: caddy, frps, dnsmasq, iptables, git, rg, fd, gh
- **Agent CLIs**: pi, codex (npm -g), opencode (curl installer), claude (curl installer)
- **Caddy root CA**: pre-generated at build time and installed into the system trust store via `update-ca-certificates`. Env vars set globally: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`.
- **Home skeleton**: `.bashrc` (PATH setup, env sourcing), `.iterate/bin/` wrappers (claude, codex, pidnap, iterate), `.iterate/caddy/Caddyfile`

Build: `pnpm --filter @iterate-com/jonasland-sandbox build` (uses depot)

## Entrypoint (`sandbox/entry.sh`)

1. Syncs repo from host (if `DOCKER_HOST_SYNC_ENABLED=true`)
2. Syncs home skeleton
3. Entrypoint-args override: positional args (`docker run <image> sleep infinity`) or `SANDBOX_ENTRY_ARGS` env var (tab-delimited)
4. Starts dnsmasq (\*.iterate.localhost → 127.0.0.1)
5. Installs iptables NAT rules (port 80/443 → caddy, exempt egress-proxy user)
6. Starts pidnap (`pidnap.config.ts`)

## Egress model

All outbound HTTP/HTTPS from sandbox processes is intercepted by iptables and redirected to caddy. Caddy MITMs HTTPS with on-demand self-signed certs (trusted via the build-time root CA), then forwards to the egress-proxy service on `:19000`. The egress proxy either:

- **Transparent mode** (no `ITERATE_EGRESS_PROXY`): forwards directly to the real upstream
- **External-proxy mode**: forwards to a configured upstream proxy (e.g., a host-side mock-http-proxy)

The `iterate-egress` user is exempt from iptables rules so the egress proxy itself can reach the internet.

## Dev tooling

### `pnpm docker:shell` (`sandbox/scripts/docker-shell.ts`)

Start a container and drop into an interactive shell. Cleans up on exit.

```bash
pnpm --filter @iterate-com/jonasland-sandbox docker:shell
pnpm --filter @iterate-com/jonasland-sandbox docker:shell -- --no-pidnap
pnpm --filter @iterate-com/jonasland-sandbox docker:shell -- --image jonasland-sandbox:local
pnpm --filter @iterate-com/jonasland-sandbox docker:shell -- --env OPENAI_API_KEY --env MY_VAR=custom
```

Flags:

- `--image <tag>` — image to use (default: `$JONASLAND_SANDBOX_IMAGE`)
- `--no-pidnap` — skip full stack, just a bare shell (entry.sh runs sync then `sleep infinity`)
- `--env <VAR>` — forward host env var; `--env K=V` sets an arbitrary value

### `tsx jonasland/scripts/external-egress-proxy.ts`

Standalone HTTP proxy wrapping `@iterate-com/mock-http-proxy`. Logs requests as one-liners, records to HAR, replays from HAR archives.

```bash
# Bypass mode (forward everything, log traffic)
tsx jonasland/scripts/external-egress-proxy.ts --port 19555

# Record traffic
tsx jonasland/scripts/external-egress-proxy.ts --port 19555 --record out.har

# Replay from archive, bypass unmatched
tsx jonasland/scripts/external-egress-proxy.ts --replay traffic.har

# Replay from archive, reject unmatched
tsx jonasland/scripts/external-egress-proxy.ts --replay traffic.har --unhandled error
```

Flags:

- `--port <n>` — bind port (default: random)
- `--host <addr>` — bind address (default: 0.0.0.0)
- `--record <path>` — record to HAR file
- `--replay <path>` — serve from HAR archive
- `--unhandled bypass|warn|error` — behavior for unmatched requests (default: bypass)
- `--quiet` — suppress per-request log lines

### Typical rig: host proxy + sandbox container

```bash
# Terminal 1: start egress proxy on host
tsx jonasland/scripts/external-egress-proxy.ts --port 19555

# Terminal 2: start container pointing at host proxy
pnpm --filter @iterate-com/jonasland-sandbox docker:shell -- \
  --env OPENAI_API_KEY --env ANTHROPIC_API_KEY \
  --env ITERATE_EGRESS_PROXY=http://host.docker.internal:19555

# Inside container, all HTTPS traffic flows through:
#   process → iptables → caddy MITM → external-egress-proxy → host proxy → internet
```

## E2E tests

The main inner loop is now namespace-based and file-prefix-based.

Prefer these command shapes:

```bash
# From repo root
pnpm jonasland e2e vitest 02a
pnpm jonasland e2e vitest 02b -t docker
pnpm jonasland e2e vitest:fly 02b
pnpm jonasland e2e vitest:all 02b -t fly

# From jonasland/e2e
pnpm vitest 02a
pnpm vitest 02b -t no-internet
pnpm vitest:fly 02c
```

Important conventions:

- plain `pnpm vitest ...` excludes `fly` by default
- use `pnpm vitest:fly ...` or `pnpm vitest:all ...` when you explicitly want Fly coverage
- raw short tags are mirrored into test titles by the local `test` wrapper in `e2e/test-support/e2e-test.ts`
- that means `-t docker`, `-t fly`, `-t no-internet`, `-t slow`, and `-t third-party` are supported, reliable inclusive filters
- use `--tags-filter` for exact tag slicing

Vitest files use numeric prefixes so plain Vitest file filtering stays ergonomic:

- `01a-provider-contract.e2e.test.ts`
- `02a-ingress.e2e.test.ts`
- `02b-egress.e2e.test.ts`
- `02c-public-ingress.e2e.test.ts`
- `02d-internal-ingress.e2e.test.ts`

Parameterization pattern: env-based provider cases → `describe.each(cases)` → local wrapped `test(...)`.

Key env vars:

- `E2E_DOCKER_IMAGE_REF` / `E2E_FLY_IMAGE_REF` / `JONASLAND_SANDBOX_IMAGE` — image tags
- `FLY_API_TOKEN` — required for Fly tests
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — required for agent CLI tests
- `DOCKER_HOST_SYNC_ENABLED`, `DOCKER_HOST_GIT_REPO_ROOT` — for host sync
