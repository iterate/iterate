---
state: done
priority: high
size: medium
dependsOn: []
---

# Env Var Audit (2026-02-09)

Generated from source + Doppler (`os` project, configs: `dev`, `stg`, `prd`). Values are not printed; only presence/default drift status.

## Scope

- Source scan: TS/JS, shell, Dockerfile, package scripts, GitHub workflows (`.github/workflows` + `.github/ts-workflows`).
- Doppler comparison: `doppler secrets download --project os --config {dev|stg|prd} --format json --no-file`.
- Excluded: markdown/docs/tasks and scratch `tmp-*` files.

## Headline numbers

- External env vars referenced in code/config: **159**
- Vars with literal defaults encoded in source: **52**
- Referenced vars present in Doppler (dev/stg/prd union): **44**
- Referenced vars not present in Doppler: **115**
- Doppler vars not referenced in code scan: **61**
- Tagged counts: sandbox **68**, ci/build **26**, git **21**

## Canonical runtime contract (`apps/os/alchemy.run.ts`)

- Schema vars: **49** (required 25, optional 21, defaulted 3)
- Doppler presence status per config shown below.

| Var                                   | Mode                 |       Default | dev                 | stg                 | prd                 | Source                       |
| ------------------------------------- | -------------------- | ------------: | ------------------- | ------------------- | ------------------- | ---------------------------- |
| `BETTER_AUTH_SECRET`                  | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:264` |
| `DAYTONA_API_KEY`                     | required             |             - | present             | absent              | present             | `apps/os/alchemy.run.ts:265` |
| `DAYTONA_DEFAULT_SNAPSHOT`            | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:266` |
| `DAYTONA_ORG_ID`                      | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:267` |
| `VITE_DAYTONA_DEFAULT_SNAPSHOT`       | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:268` |
| `DAYTONA_DEFAULT_AUTO_STOP_MINUTES`   | defaulted            |             0 | absent-uses-default | absent-uses-default | absent-uses-default | `apps/os/alchemy.run.ts:269` |
| `DAYTONA_DEFAULT_AUTO_DELETE_MINUTES` | defaulted            |            -1 | absent-uses-default | absent-uses-default | absent-uses-default | `apps/os/alchemy.run.ts:270` |
| `SANDBOX_DAYTONA_ENABLED`             | optional-bool-string |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:271` |
| `SANDBOX_DOCKER_ENABLED`              | optional-bool-string |             - | present             | absent              | absent              | `apps/os/alchemy.run.ts:272` |
| `SANDBOX_FLY_ENABLED`                 | optional-bool-string |             - | present             | present             | present             | `apps/os/alchemy.run.ts:273` |
| `SANDBOX_MACHINE_PROVIDERS`           | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:274` |
| `FLY_API_TOKEN`                       | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:275` |
| `FLY_API_TOKEN`                       | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:275` |
| `FLY_ORG`                             | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:277` |
| `FLY_DEFAULT_REGION`                  | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:278` |
| `FLY_DEFAULT_IMAGE`                   | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:279` |
| `FLY_APP_NAME_PREFIX`                 | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:280` |
| `FLY_NETWORK`                         | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:281` |
| `FLY_BASE_DOMAIN`                     | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:282` |
| `GOOGLE_CLIENT_ID`                    | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:283` |
| `GOOGLE_CLIENT_SECRET`                | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:284` |
| `OPENAI_API_KEY`                      | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:285` |
| `ANTHROPIC_API_KEY`                   | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:286` |
| `REPLICATE_API_TOKEN`                 | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:287` |
| `SLACK_CLIENT_ID`                     | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:288` |
| `SLACK_CLIENT_SECRET`                 | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:289` |
| `SLACK_SIGNING_SECRET`                | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:290` |
| `GITHUB_APP_CLIENT_ID`                | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:291` |
| `GITHUB_APP_CLIENT_SECRET`            | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:292` |
| `GITHUB_APP_SLUG`                     | required             |             - | present             | absent              | present             | `apps/os/alchemy.run.ts:293` |
| `GITHUB_APP_ID`                       | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:294` |
| `GITHUB_APP_PRIVATE_KEY`              | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:295` |
| `GITHUB_WEBHOOK_SECRET`               | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:296` |
| `STRIPE_SECRET_KEY`                   | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:297` |
| `STRIPE_WEBHOOK_SECRET`               | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:298` |
| `STRIPE_METERED_PRICE_ID`             | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:299` |
| `RESEND_BOT_DOMAIN`                   | required             |             - | present             | absent              | present             | `apps/os/alchemy.run.ts:300` |
| `RESEND_BOT_API_KEY`                  | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:301` |
| `RESEND_BOT_WEBHOOK_SECRET`           | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:302` |
| `POSTHOG_PUBLIC_KEY`                  | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:303` |
| `VITE_PUBLIC_URL`                     | required             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:305` |
| `VITE_APP_STAGE`                      | required             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:306` |
| `APP_STAGE`                           | required             |             - | absent              | present             | present             | `apps/os/alchemy.run.ts:307` |
| `ENCRYPTION_SECRET`                   | required             |             - | present             | absent              | present             | `apps/os/alchemy.run.ts:308` |
| `VITE_POSTHOG_PUBLIC_KEY`             | optional             |             - | present             | present             | present             | `apps/os/alchemy.run.ts:310` |
| `VITE_POSTHOG_PROXY_URL`              | optional             |             - | absent              | absent              | absent              | `apps/os/alchemy.run.ts:311` |
| `SIGNUP_ALLOWLIST`                    | defaulted            | \*@nustom.com | overrides-default   | overrides-default   | overrides-default   | `apps/os/alchemy.run.ts:312` |
| `VITE_ENABLE_EMAIL_OTP_SIGNIN`        | optional-bool-string |             - | present             | present             | present             | `apps/os/alchemy.run.ts:313` |
| `DANGEROUS_RAW_SECRETS_ENABLED`       | optional-bool-string |             - | present             | absent              | present             | `apps/os/alchemy.run.ts:317` |

### Missing in at least one config (from canonical runtime contract)

- `DAYTONA_API_KEY`
- `DAYTONA_DEFAULT_SNAPSHOT`
- `VITE_DAYTONA_DEFAULT_SNAPSHOT`
- `DAYTONA_DEFAULT_AUTO_STOP_MINUTES`
- `DAYTONA_DEFAULT_AUTO_DELETE_MINUTES`
- `SANDBOX_DAYTONA_ENABLED`
- `SANDBOX_DOCKER_ENABLED`
- `SANDBOX_MACHINE_PROVIDERS`
- `FLY_API_TOKEN`
- `FLY_DEFAULT_REGION`
- `FLY_DEFAULT_IMAGE`
- `FLY_NETWORK`
- `FLY_BASE_DOMAIN`
- `GITHUB_APP_SLUG`
- `RESEND_BOT_DOMAIN`
- `VITE_APP_STAGE`
- `APP_STAGE`
- `ENCRYPTION_SECRET`
- `VITE_POSTHOG_PROXY_URL`
- `DANGEROUS_RAW_SECRETS_ENABLED`

## Doppler overlap analysis (all referenced vars)

- Referenced + present in Doppler: **44**
- Present in all 3 configs: **35**
- Missing in >=1 config: **9**
- Present in all 3 but differing value across configs: **26**
- Present in all 3 with same value: **9**

### Present in all 3 with same value

- `ALCHEMY_PASSWORD`
- `BETTER_AUTH_SECRET`
- `DAYTONA_ORG_ID`
- `FLY_API_TOKEN`
- `FLY_ORG`
- `REPLICATE_API_TOKEN`
- `SANDBOX_FLY_ENABLED`
- `SLACK_CI_BOT_TOKEN`
- `VITE_ENABLE_EMAIL_OTP_SIGNIN`

### Missing in one or more config

- `APP_STAGE`: dev=no, stg=yes, prd=yes
- `DANGEROUS_RAW_SECRETS_ENABLED`: dev=yes, stg=no, prd=yes
- `DAYTONA_API_KEY`: dev=yes, stg=no, prd=yes
- `DEV_TUNNEL`: dev=yes, stg=no, prd=no
- `ENCRYPTION_SECRET`: dev=yes, stg=no, prd=yes
- `GITHUB_APP_SLUG`: dev=yes, stg=no, prd=yes
- `ITERATE_USER`: dev=yes, stg=yes, prd=no
- `RESEND_BOT_DOMAIN`: dev=yes, stg=no, prd=yes
- `SANDBOX_DOCKER_ENABLED`: dev=yes, stg=no, prd=no

## Defaults encoded in source

- Status legend: `matches-default` means Doppler value equals code default; `overrides-default` means explicit non-default value; `missing-uses-default` means no Doppler key so code/default path applies.

| Var                                   | Default(s)                                                                                                                                                                                                                                                                                              | dev                  | stg                  | prd                  | Example source                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------- | -------------------- | -------------------------------------------------------- |
| `APP_URL`                             | http://localhost:5173                                                                                                                                                                                                                                                                                   | missing-uses-default | missing-uses-default | missing-uses-default | `playwright.config.ts:3`                                 |
| `CI`                                  | true                                                                                                                                                                                                                                                                                                    | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/setup-background-agent/Dockerfile:29`           |
| `DAEMON_NAME`                         | test-daemon                                                                                                                                                                                                                                                                                             | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/test-daemon.ts:24`                              |
| `DATABASE_URL`                        | ./db.sqlite                                                                                                                                                                                                                                                                                             | missing-uses-default | missing-uses-default | missing-uses-default | `apps/daemon/drizzle.config.ts:11`                       |
| `DAYTONA_DEFAULT_SNAPSHOT_CPU`        | 2                                                                                                                                                                                                                                                                                                       | matches-default      | matches-default      | overrides-default    | `sandbox/providers/daytona/push-snapshot.ts:38`          |
| `DAYTONA_DEFAULT_SNAPSHOT_DISK`       | 10                                                                                                                                                                                                                                                                                                      | overrides-default    | overrides-default    | matches-default      | `sandbox/providers/daytona/push-snapshot.ts:47`          |
| `DAYTONA_DEFAULT_SNAPSHOT_MEMORY`     | 4                                                                                                                                                                                                                                                                                                       | matches-default      | matches-default      | overrides-default    | `sandbox/providers/daytona/push-snapshot.ts:42`          |
| `DAYTONA_DEFAULT_AUTO_DELETE_MINUTES` | -1                                                                                                                                                                                                                                                                                                      | missing-uses-default | missing-uses-default | missing-uses-default | `apps/os/alchemy.run.ts:270`                             |
| `DAYTONA_DEFAULT_AUTO_STOP_MINUTES`   | 0                                                                                                                                                                                                                                                                                                       | missing-uses-default | missing-uses-default | missing-uses-default | `apps/os/alchemy.run.ts:269`                             |
| `DOCKER_TUNNEL_PORTS`                 | -3000,3001,4096,9876                                                                                                                                                                                                                                                                                    | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/docker/start-cloudflare-tunnels.sh:4` |
| `DOCKER_HOST`                         | tcp://127.0.0.1:2375                                                                                                                                                                                                                                                                                    | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/docker/api.ts:15`                     |
| `DOCKER_DEFAULT_SERVICE_TRANSPORT`    | -port-map                                                                                                                                                                                                                                                                                               | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/entry.sh:17`                                    |
| `DOCKER_HOST_SYNC_ENABLED`            | -                                                                                                                                                                                                                                                                                                       | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/entry.sh:9`                                     |
| `DOPPLER_CONFIG`                      | -dev                                                                                                                                                                                                                                                                                                    | overrides-default    | overrides-default    | overrides-default    | `scripts/async-coding-agent-setup.sh:8`                  |
| `FLY_BASE_DOMAIN`                     | fly.dev                                                                                                                                                                                                                                                                                                 | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/fly/provider.ts:41`                   |
| `FLY_ORG`                             | iterate                                                                                                                                                                                                                                                                                                 | matches-default      | matches-default      | matches-default      | `sandbox/providers/docker/build-image.ts:24`             |
| `FLY_DEFAULT_REGION`                  | ord                                                                                                                                                                                                                                                                                                     | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/fly/provider.ts:31`                   |
| `GIT_SHA`                             | unknown<br>$GIT_SHA                                                                                                                                                                                                                                                                                     | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:164`                                 |
| `HOSTNAME`                            | localhost                                                                                                                                                                                                                                                                                               | missing-uses-default | missing-uses-default | missing-uses-default | `apps/daemon/server.ts:3`                                |
| `ITERATE_EGRESS_PROXY_URL`            | -https://dev-nick-os.dev.iterate.com/api/egress-proxy                                                                                                                                                                                                                                                   | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/test/test-egress-proxy.sh:31`                   |
| `ITERATE_OS_API_KEY`                  | -test-dev-key                                                                                                                                                                                                                                                                                           | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/test/test-egress-proxy.sh:32`                   |
| `ITERATE_REPO`                        | -/home/iterate/src/github.com/iterate/iterate<br>-$HOME/src/github.com/iterate/iterate<br>/home/iterate/src/github.com/iterate/iterate                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/after-repo-sync-steps.sh:4`                     |
| `ITERATE_USER`                        | unknown                                                                                                                                                                                                                                                                                                 | overrides-default    | overrides-default    | missing-uses-default | `sandbox/providers/daytona/push-snapshot.ts:32`          |
| `LOCAL_DOCKER_IMAGE_NAME`             | iterate-sandbox:local                                                                                                                                                                                                                                                                                   | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/docker/build-image.ts:42`             |
| `LOCAL_DOCKER_POSTGRES_PORT`          | 5432                                                                                                                                                                                                                                                                                                    | missing-uses-default | missing-uses-default | missing-uses-default | `apps/os/alchemy.run.ts:381`                             |
| `LOCAL_DOCKER_SYNC_FROM_GIT_TARGET`   | -                                                                                                                                                                                                                                                                                                       | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/sync-repo-from-git-remote.sh:5`                 |
| `NODE_VERSION`                        | -24.4.1<br>24.4.1<br>${NODE_VERSION}                                                                                                                                                                                                                                                                    | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/async-coding-agent-setup.sh:6`                  |
| `NVM_DIR`                             | /home/agent/.nvm                                                                                                                                                                                                                                                                                        | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/setup-background-agent/Dockerfile:30`           |
| `PATH`                                | "${PNPM_HOME}:${NVM_DIR}/versions/node/v${NODE_VERSION}/bin:${PATH}"<br>"/home/iterate/.iterate/bin:/home/iterate/.local/bin:$PATH"<br>"/home/iterate/.npm-global/bin:$PATH"<br>"/home/iterate/.bun/bin:$PATH"<br>"/usr/local/go/bin:/home/iterate/go/bin:$PATH"<br>"/home/iterate/.opencode/bin:$PATH" | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/setup-background-agent/Dockerfile:38`           |
| `PIDNAP_RPC_URL`                      | http://localhost:9876/rpc                                                                                                                                                                                                                                                                               | missing-uses-default | missing-uses-default | missing-uses-default | `packages/pidnap/src/api/client.ts:24`                   |
| `PNPM_HOME`                           | /home/agent/.local/share/pnpm                                                                                                                                                                                                                                                                           | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/setup-background-agent/Dockerfile:31`           |
| `PNPM_VERSION`                        | -10.17.1                                                                                                                                                                                                                                                                                                | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/async-coding-agent-setup.sh:7`                  |
| `PORT`                                | 3001                                                                                                                                                                                                                                                                                                    | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/test-daemon.ts:25`                              |
| `SANDBOX_BUN_VERSION`                 | 1.3.6                                                                                                                                                                                                                                                                                                   | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:9`                                   |
| `SANDBOX_CLAUDE_CODE_VERSION`         | 2.1.37                                                                                                                                                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:7`                                   |
| `SANDBOX_CODEX_VERSION`               | 0.98.0                                                                                                                                                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:5`                                   |
| `DOCKER_HOST_GIT_COMMON_DIR`          | -/host/commondir                                                                                                                                                                                                                                                                                        | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/docker/sync-repo-from-host.sh:9`      |
| `DOCKER_HOST_GIT_DIR`                 | -/host/gitdir                                                                                                                                                                                                                                                                                           | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/docker/sync-repo-from-host.sh:8`      |
| `SANDBOX_ENTRY_ARGS`                  | -                                                                                                                                                                                                                                                                                                       | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/entry.sh:30`                                    |
| `SANDBOX_FLY_REGISTRY_APP`            | iterate-sandbox-image                                                                                                                                                                                                                                                                                   | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/providers/docker/build-image.ts:25`             |
| `SANDBOX_GO_VERSION`                  | 1.23.4                                                                                                                                                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:10`                                  |
| `SANDBOX_GOGCLI_REF`                  | 99d957581f61532de08f3847e79f639edad3c68b                                                                                                                                                                                                                                                                | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:11`                                  |
| `SANDBOX_OPENCODE_VERSION`            | 1.1.53                                                                                                                                                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:6`                                   |
| `SANDBOX_PI_CODING_AGENT_VERSION`     | 0.52.8                                                                                                                                                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/Dockerfile:8`                                   |
| `SANDBOX_TEST_BASE_DAYTONA_SNAPSHOT`  | daytona-small                                                                                                                                                                                                                                                                                           | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/test/helpers.ts:116`                            |
| `SANDBOX_TEST_BASE_DOCKER_IMAGE`      | iterate-sandbox:local                                                                                                                                                                                                                                                                                   | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/test/helpers.ts:115`                            |
| `SANDBOX_TEST_BASE_FLY_IMAGE`         | registry.fly.io/iterate-sandbox-image:main                                                                                                                                                                                                                                                              | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/test/helpers.ts:117`                            |
| `SANDBOX_TEST_PROVIDER`               | docker                                                                                                                                                                                                                                                                                                  | missing-uses-default | missing-uses-default | missing-uses-default | `sandbox/test/helpers.ts:99`                             |
| `SHELL`                               | /bin/bash                                                                                                                                                                                                                                                                                               | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/setup-background-agent/Dockerfile:32`           |
| `SIGNUP_ALLOWLIST`                    | \*@nustom.com                                                                                                                                                                                                                                                                                           | overrides-default    | overrides-default    | overrides-default    | `apps/os/alchemy.run.ts:312`                             |
| `STARTUP_DELAY`                       | 0                                                                                                                                                                                                                                                                                                       | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/test-daemon.ts:26`                              |
| `UBUNTU_CODENAME`                     | -$VERSION_CODENAME                                                                                                                                                                                                                                                                                      | missing-uses-default | missing-uses-default | missing-uses-default | `scripts/setup-background-agent/setup-ubuntu-base.sh:59` |

## Sandbox-related vars (68)

| Var                                      | Doppler configs | Default(s)                                 | Refs                                                                                                                                           |
| ---------------------------------------- | --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_TUNNEL_HOSTNAME`             | -               | -                                          | `sandbox/pidnap.config.ts:13`                                                                                                                  |
| `CLOUDFLARE_TUNNEL_URL`                  | -               | -                                          | `sandbox/pidnap.config.ts:14`                                                                                                                  |
| `DAYTONA_API_KEY`                        | dev, prd        | -                                          | `apps/os/alchemy.run.ts:265`<br>`sandbox/providers/daytona/push-snapshot.ts:62`<br>`sandbox/providers/daytona/push-snapshot.ts:62`             |
| `DAYTONA_DEFAULT_SNAPSHOT_CPU`           | dev, stg, prd   | 2                                          | `sandbox/providers/daytona/push-snapshot.ts:38`<br>`sandbox/providers/daytona/push-snapshot.ts:38`                                             |
| `DAYTONA_DEFAULT_SNAPSHOT_DISK`          | dev, stg, prd   | 10                                         | `sandbox/providers/daytona/push-snapshot.ts:47`<br>`sandbox/providers/daytona/push-snapshot.ts:47`                                             |
| `DAYTONA_DEFAULT_SNAPSHOT_MEMORY`        | dev, stg, prd   | 4                                          | `sandbox/providers/daytona/push-snapshot.ts:42`<br>`sandbox/providers/daytona/push-snapshot.ts:42`                                             |
| `DAYTONA_ORG_ID`                         | dev, stg, prd   | -                                          | `apps/os/alchemy.run.ts:267`                                                                                                                   |
| `DAYTONA_DEFAULT_AUTO_DELETE_MINUTES`    | -               | -1                                         | `apps/os/alchemy.run.ts:270`<br>`apps/os/alchemy.run.ts:270`                                                                                   |
| `DAYTONA_DEFAULT_AUTO_STOP_MINUTES`      | -               | 0                                          | `apps/os/alchemy.run.ts:269`<br>`apps/os/alchemy.run.ts:269`                                                                                   |
| `DAYTONA_DEFAULT_SNAPSHOT`               | -               | -                                          | `apps/os/alchemy.run.ts:266`<br>`sandbox/providers/daytona/push-snapshot.ts:214`<br>`sandbox/providers/daytona/push-snapshot.ts:221`           |
| `DOCKER_TUNNEL_PORTS`                    | -               | -3000,3001,4096,9876                       | `sandbox/providers/docker/start-cloudflare-tunnels.sh:4`                                                                                       |
| `DOCKER_COMPOSE_PROJECT_NAME`            | -               | -                                          | `apps/os/alchemy.run.ts:485`<br>`apps/os/alchemy.run.ts:497`<br>`apps/os/alchemy.run.ts:515`                                                   |
| `DOCKER_HOST`                            | -               | tcp://127.0.0.1:2375                       | `sandbox/providers/daytona/push-snapshot.ts:23`<br>`sandbox/providers/daytona/push-snapshot.ts:26`<br>`sandbox/providers/docker/api.ts:15`     |
| `DOCKER_DEFAULT_IMAGE`                   | -               | -                                          | `apps/os/alchemy.run.ts:484`<br>`apps/os/alchemy.run.ts:509`<br>`apps/os/alchemy.run.ts:514`                                                   |
| `DOCKER_DEFAULT_SERVICE_TRANSPORT`       | -               | -port-map                                  | `sandbox/entry.sh:17`                                                                                                                          |
| `DOCKER_HOST_SYNC_ENABLED`               | -               | -                                          | `sandbox/entry.sh:9`                                                                                                                           |
| `FLY_API_TOKEN`                          | dev, stg, prd   | -                                          | `apps/os/alchemy.run.ts:275`<br>`sandbox/providers/docker/build-image.ts:23`                                                                   |
| `FLY_API_TOKEN`                          | -               | -                                          | `apps/os/alchemy.run.ts:275`<br>`sandbox/providers/docker/build-image.ts:23`                                                                   |
| `FLY_BASE_DOMAIN`                        | -               | fly.dev                                    | `apps/os/alchemy.run.ts:282`<br>`sandbox/providers/fly/provider.ts:41`                                                                         |
| `FLY_DEFAULT_IMAGE`                      | -               | -                                          | `apps/os/alchemy.run.ts:279`                                                                                                                   |
| `FLY_NETWORK`                            | -               | -                                          | `apps/os/alchemy.run.ts:281`                                                                                                                   |
| `FLY_ORG`                                | dev, stg, prd   | iterate                                    | `apps/os/alchemy.run.ts:277`<br>`sandbox/providers/docker/build-image.ts:24`<br>`sandbox/providers/docker/build-image.ts:24`                   |
| `FLY_DEFAULT_REGION`                     | -               | ord                                        | `apps/os/alchemy.run.ts:278`<br>`sandbox/providers/fly/provider.ts:31`                                                                         |
| `ITERATE_SKIP_PROXY`                     | -               | -                                          | `sandbox/pidnap.config.ts:19`                                                                                                                  |
| `KEEP_SANDBOX_CONTAINER`                 | -               | -                                          | `sandbox/test/helpers.ts:111`                                                                                                                  |
| `LOCAL_DOCKER_COMPOSE_PROJECT_NAME`      | -               | -                                          | `apps/os/alchemy.run.ts:492`<br>`apps/os/alchemy.run.ts:522`<br>`apps/os/alchemy.run.ts:523`                                                   |
| `LOCAL_DOCKER_IMAGE_NAME`                | -               | iterate-sandbox:local                      | `apps/os/alchemy.run.ts:491`<br>`apps/os/alchemy.run.ts:510`<br>`apps/os/alchemy.run.ts:521`                                                   |
| `LOCAL_DOCKER_NEON_PROXY_PORT`           | -               | -                                          | `apps/os/alchemy.run.ts:122`                                                                                                                   |
| `LOCAL_DOCKER_POSTGRES_PORT`             | -               | 5432                                       | `apps/os/scripts/local-docker-postgres-port.ts:10`<br>`apps/os/alchemy.run.ts:121`<br>`apps/os/alchemy.run.ts:381`                             |
| `LOCAL_DOCKER_REPO_CHECKOUT`             | -               | -                                          | `apps/os/alchemy.run.ts:493`<br>`apps/os/alchemy.run.ts:524`<br>`apps/os/alchemy.run.ts:524`                                                   |
| `LOCAL_DOCKER_SYNC_FROM_GIT_TARGET`      | -               | -                                          | `sandbox/sync-repo-from-git-remote.sh:5`                                                                                                       |
| `PIDNAP_ACTION`                          | -               | -                                          | `sandbox/test/daemon-in-sandbox.test.ts:68`                                                                                                    |
| `PIDNAP_AUTH_TOKEN`                      | -               | -                                          | `packages/pidnap/src/api/client.ts:25`                                                                                                         |
| `PIDNAP_INPUT_B64`                       | -               | -                                          | `sandbox/test/daemon-in-sandbox.test.ts:69`<br>`sandbox/test/daemon-in-sandbox.test.ts:69`                                                     |
| `PIDNAP_RPC_URL`                         | -               | http://localhost:9876/rpc                  | `packages/pidnap/src/api/client.ts:24`<br>`packages/pidnap/src/api/client.ts:24`                                                               |
| `REQUIRE_CLOUDFLARE_TUNNEL_TEST_SUCCESS` | -               | -                                          | `sandbox/providers/docker/cloudflare-tunnel.test.ts:11`                                                                                        |
| `RUN_DOCKER_CLOUDFLARE_TUNNEL_TESTS`     | -               | -                                          | `sandbox/providers/docker/cloudflare-tunnel.test.ts:9`                                                                                         |
| `RUN_SANDBOX_TESTS`                      | -               | -                                          | `sandbox/test/helpers.ts:106`<br>`sandbox/test/helpers.ts:107`<br>`sandbox/test/helpers.ts:108`                                                |
| `SANDBOX_BUILD_PLATFORM`                 | -               | -                                          | `.github/ts-workflows/workflows/sandbox-test.ts:96`<br>`.github/workflows/sandbox-test.yml:73`<br>`sandbox/providers/docker/build-image.ts:19` |
| `SANDBOX_BUN_VERSION`                    | -               | 1.3.6                                      | `sandbox/Dockerfile:9`<br>`sandbox/Dockerfile:84`                                                                                              |
| `SANDBOX_CLAUDE_CODE_VERSION`            | -               | 2.1.37                                     | `sandbox/Dockerfile:7`<br>`sandbox/Dockerfile:106`                                                                                             |
| `SANDBOX_CODEX_VERSION`                  | -               | 0.98.0                                     | `sandbox/Dockerfile:5`<br>`sandbox/Dockerfile:105`                                                                                             |
| `SANDBOX_DAYTONA_ENABLED`                | -               | -                                          | `apps/os/alchemy.run.ts:271`                                                                                                                   |
| `SANDBOX_DEPOT_SAVE_TAG`                 | -               | -                                          | `sandbox/providers/docker/build-image.ts:22`                                                                                                   |
| `SANDBOX_DOCKER_ENABLED`                 | dev             | -                                          | `apps/os/alchemy.run.ts:272`                                                                                                                   |
| `DOCKER_HOST_GIT_BRANCH`                 | -               | -                                          | `apps/os/alchemy.run.ts:490`<br>`apps/os/alchemy.run.ts:507`<br>`apps/os/alchemy.run.ts:520`                                                   |
| `DOCKER_HOST_GIT_COMMIT`                 | -               | -                                          | `apps/os/alchemy.run.ts:489`<br>`apps/os/alchemy.run.ts:505`<br>`apps/os/alchemy.run.ts:519`                                                   |
| `DOCKER_HOST_GIT_COMMON_DIR`             | -               | -/host/commondir                           | `apps/os/alchemy.run.ts:488`<br>`apps/os/alchemy.run.ts:503`<br>`apps/os/alchemy.run.ts:518`                                                   |
| `DOCKER_HOST_GIT_DIR`                    | -               | -/host/gitdir                              | `apps/os/alchemy.run.ts:487`<br>`apps/os/alchemy.run.ts:501`<br>`apps/os/alchemy.run.ts:517`                                                   |
| `DOCKER_HOST_GIT_REPO_ROOT`              | -               | -                                          | `apps/os/alchemy.run.ts:486`<br>`apps/os/alchemy.run.ts:499`<br>`apps/os/alchemy.run.ts:516`                                                   |
| `SANDBOX_ENTRY_ARGS`                     | -               | -                                          | `sandbox/entry.sh:30`<br>`sandbox/entry.sh:31`<br>`sandbox/providers/daytona/entrypoint-arguments.test.ts:30`                                  |
| `FLY_APP_NAME_PREFIX`                    | dev, stg, prd   | -                                          | `apps/os/alchemy.run.ts:280`                                                                                                                   |
| `SANDBOX_FLY_ENABLED`                    | dev, stg, prd   | -                                          | `apps/os/alchemy.run.ts:273`                                                                                                                   |
| `SANDBOX_FLY_REGISTRY_APP`               | -               | iterate-sandbox-image                      | `.github/ts-workflows/workflows/sandbox-test.ts:98`<br>`.github/workflows/sandbox-test.yml:75`<br>`sandbox/providers/docker/build-image.ts:25` |
| `SANDBOX_GO_VERSION`                     | -               | 1.23.4                                     | `sandbox/Dockerfile:10`<br>`sandbox/Dockerfile:90`                                                                                             |
| `SANDBOX_GOGCLI_REF`                     | -               | 99d957581f61532de08f3847e79f639edad3c68b   | `sandbox/Dockerfile:11`<br>`sandbox/Dockerfile:99`                                                                                             |
| `SANDBOX_MACHINE_PROVIDERS`              | -               | -                                          | `apps/os/alchemy.run.ts:274`                                                                                                                   |
| `SANDBOX_OPENCODE_VERSION`               | -               | 1.1.53                                     | `sandbox/Dockerfile:6`<br>`sandbox/Dockerfile:107`                                                                                             |
| `SANDBOX_PI_CODING_AGENT_VERSION`        | -               | 0.52.8                                     | `sandbox/Dockerfile:8`<br>`sandbox/Dockerfile:104`                                                                                             |
| `SANDBOX_PUSH_FLY_REGISTRY`              | -               | -                                          | `.github/ts-workflows/workflows/sandbox-test.ts:97`<br>`.github/workflows/sandbox-test.yml:74`<br>`sandbox/providers/docker/build-image.ts:27` |
| `SANDBOX_PUSH_FLY_REGISTRY_MAIN`         | -               | -                                          | `sandbox/providers/docker/build-image.ts:29`                                                                                                   |
| `SANDBOX_TEST_BASE_DAYTONA_SNAPSHOT`     | -               | daytona-small                              | `sandbox/test/helpers.ts:116`<br>`sandbox/test/helpers.ts:116`                                                                                 |
| `SANDBOX_TEST_BASE_DOCKER_IMAGE`         | -               | iterate-sandbox:local                      | `sandbox/test/helpers.ts:115`<br>`sandbox/test/helpers.ts:115`                                                                                 |
| `SANDBOX_TEST_BASE_FLY_IMAGE`            | -               | registry.fly.io/iterate-sandbox-image:main | `sandbox/test/helpers.ts:117`<br>`sandbox/test/helpers.ts:117`                                                                                 |
| `SANDBOX_TEST_PROVIDER`                  | -               | docker                                     | `sandbox/test/helpers.ts:99`<br>`sandbox/test/helpers.ts:99`                                                                                   |
| `SANDBOX_TEST_SNAPSHOT_ID`               | -               | -                                          | `sandbox/test/helpers.ts:102`                                                                                                                  |
| `SANDBOX_USE_DEPOT_REGISTRY`             | -               | -                                          | `sandbox/providers/docker/build-image.ts:21`                                                                                                   |
| `VITE_DAYTONA_DEFAULT_SNAPSHOT`          | -               | -                                          | `apps/os/app/routes/proj/machines.tsx:30`<br>`apps/os/alchemy.run.ts:268`                                                                      |

## CI/build-related vars (26)

| Var                              | Doppler configs | Default(s)                           | Refs                                                                                                                                                              |
| -------------------------------- | --------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`                             | -               | true                                 | `playwright.config.ts:10`<br>`playwright.config.ts:11`<br>`playwright.config.ts:23`                                                                               |
| `CLAUDE_DOPPLER_TOKEN`           | -               | -                                    | `.github/ts-workflows/workflows/claude-assistant.ts:70`<br>`.github/ts-workflows/workflows/claude-assistant.ts:83`<br>`.github/workflows/claude-assistant.yml:49` |
| `DOPPLER_TOKEN`                  | -               | -                                    | `.github/ts-workflows/utils/index.ts:57`<br>`.github/ts-workflows/utils/slack.ts:8`<br>`.github/ts-workflows/workflows/daytona-test.ts:72`                        |
| `GITHUB_APP_CLIENT_ID`           | dev, stg, prd   | -                                    | `apps/os/alchemy.run.ts:291`                                                                                                                                      |
| `GITHUB_APP_CLIENT_SECRET`       | dev, stg, prd   | -                                    | `apps/os/alchemy.run.ts:292`                                                                                                                                      |
| `GITHUB_APP_ID`                  | dev, stg, prd   | -                                    | `apps/os/alchemy.run.ts:294`                                                                                                                                      |
| `GITHUB_APP_PRIVATE_KEY`         | dev, stg, prd   | -                                    | `apps/os/alchemy.run.ts:295`                                                                                                                                      |
| `GITHUB_APP_SLUG`                | dev, prd        | -                                    | `apps/os/alchemy.run.ts:293`                                                                                                                                      |
| `GITHUB_ENV`                     | -               | -                                    | `.github/ts-workflows/workflows/generate-workflows.ts:63`<br>`.github/workflows/generate-workflows.yml:45`                                                        |
| `GITHUB_OUTPUT`                  | -               | -                                    | `apps/os/alchemy.run.ts:614`<br>`apps/os/alchemy.run.ts:617`<br>`.github/ts-workflows/workflows/release.ts:57`                                                    |
| `GITHUB_STEP_SUMMARY`            | -               | -                                    | `spec/analyze-flaky-tests.cjs:101`                                                                                                                                |
| `GITHUB_WEBHOOK_SECRET`          | dev, stg, prd   | -                                    | `apps/os/alchemy.run.ts:296`                                                                                                                                      |
| `ITERATE_BOT_GITHUB_TOKEN`       | -               | -                                    | `.github/ts-workflows/workflows/nag.ts:31`<br>`.github/ts-workflows/workflows/release.ts:135`<br>`.github/ts-workflows/workflows/generate-workflows.ts:19`        |
| `NEEDS`                          | -               | -                                    | `.github/ts-workflows/workflows/ci.ts:87`<br>`.github/workflows/ci.yml:102`                                                                                       |
| `NODE_VERSION`                   | -               | -24.4.1<br>24.4.1<br>${NODE_VERSION} | `scripts/async-coding-agent-setup.sh:6`<br>`scripts/setup-background-agent/setup-ubuntu-base.sh:7`<br>`scripts/setup-background-agent/Dockerfile:27`              |
| `NVM_DIR`                        | -               | /home/agent/.nvm                     | `scripts/async-coding-agent-setup.sh:39`<br>`scripts/setup-background-agent/setup-ubuntu-base.sh:20`<br>`scripts/setup-background-agent/Dockerfile:30`            |
| `PNPM_HOME`                      | -               | /home/agent/.local/share/pnpm        | `scripts/setup-background-agent/setup-ubuntu-base.sh:28`<br>`scripts/setup-background-agent/Dockerfile:31`<br>`scripts/setup-background-agent/Dockerfile:38`      |
| `PNPM_VERSION`                   | -               | -10.17.1                             | `scripts/async-coding-agent-setup.sh:7`                                                                                                                           |
| `REGISTRY_IMAGE_NAME`            | -               | -                                    | `.github/ts-workflows/workflows/sandbox-test.ts:95`<br>`.github/workflows/sandbox-test.yml:72`<br>`sandbox/providers/docker/build-image.ts:45`                    |
| `SANDBOX_BUILD_PLATFORM`         | -               | -                                    | `.github/ts-workflows/workflows/sandbox-test.ts:96`<br>`.github/workflows/sandbox-test.yml:73`<br>`sandbox/providers/docker/build-image.ts:19`                    |
| `SANDBOX_DEPOT_SAVE_TAG`         | -               | -                                    | `sandbox/providers/docker/build-image.ts:22`                                                                                                                      |
| `SANDBOX_FLY_REGISTRY_APP`       | -               | iterate-sandbox-image                | `.github/ts-workflows/workflows/sandbox-test.ts:98`<br>`.github/workflows/sandbox-test.yml:75`<br>`sandbox/providers/docker/build-image.ts:25`                    |
| `SANDBOX_PUSH_FLY_REGISTRY`      | -               | -                                    | `.github/ts-workflows/workflows/sandbox-test.ts:97`<br>`.github/workflows/sandbox-test.yml:74`<br>`sandbox/providers/docker/build-image.ts:27`                    |
| `SANDBOX_PUSH_FLY_REGISTRY_MAIN` | -               | -                                    | `sandbox/providers/docker/build-image.ts:29`                                                                                                                      |
| `SANDBOX_USE_DEPOT_REGISTRY`     | -               | -                                    | `sandbox/providers/docker/build-image.ts:21`                                                                                                                      |
| `SLACK_CI_BOT_TOKEN`             | dev, stg, prd   | -                                    | `.github/ts-workflows/utils/slack.ts:5`<br>`.github/ts-workflows/utils/slack.ts:6`<br>`.github/ts-workflows/workflows/nag.ts:61`                                  |

## Git-related vars (21)

| Var                                 | Doppler configs | Default(s)                                                                                                                             | Refs                                                                                                                                                       |
| ----------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCKER_HOST_SYNC_ENABLED`          | -               | -                                                                                                                                      | `sandbox/entry.sh:9`                                                                                                                                       |
| `GIT_SHA`                           | -               | unknown<br>$GIT_SHA                                                                                                                    | `sandbox/Dockerfile:164`<br>`sandbox/Dockerfile:170`<br>`sandbox/Dockerfile:173`                                                                           |
| `GITHUB_APP_CLIENT_ID`              | dev, stg, prd   | -                                                                                                                                      | `apps/os/alchemy.run.ts:291`                                                                                                                               |
| `GITHUB_APP_CLIENT_SECRET`          | dev, stg, prd   | -                                                                                                                                      | `apps/os/alchemy.run.ts:292`                                                                                                                               |
| `GITHUB_APP_ID`                     | dev, stg, prd   | -                                                                                                                                      | `apps/os/alchemy.run.ts:294`                                                                                                                               |
| `GITHUB_APP_PRIVATE_KEY`            | dev, stg, prd   | -                                                                                                                                      | `apps/os/alchemy.run.ts:295`                                                                                                                               |
| `GITHUB_APP_SLUG`                   | dev, prd        | -                                                                                                                                      | `apps/os/alchemy.run.ts:293`                                                                                                                               |
| `GITHUB_ENV`                        | -               | -                                                                                                                                      | `.github/ts-workflows/workflows/generate-workflows.ts:63`<br>`.github/workflows/generate-workflows.yml:45`                                                 |
| `GITHUB_OUTPUT`                     | -               | -                                                                                                                                      | `apps/os/alchemy.run.ts:614`<br>`apps/os/alchemy.run.ts:617`<br>`.github/ts-workflows/workflows/release.ts:57`                                             |
| `GITHUB_STEP_SUMMARY`               | -               | -                                                                                                                                      | `spec/analyze-flaky-tests.cjs:101`                                                                                                                         |
| `GITHUB_WEBHOOK_SECRET`             | dev, stg, prd   | -                                                                                                                                      | `apps/os/alchemy.run.ts:296`                                                                                                                               |
| `ITERATE_BOT_GITHUB_TOKEN`          | -               | -                                                                                                                                      | `.github/ts-workflows/workflows/nag.ts:31`<br>`.github/ts-workflows/workflows/release.ts:135`<br>`.github/ts-workflows/workflows/generate-workflows.ts:19` |
| `ITERATE_CUSTOMER_REPO_PATH`        | -               | -                                                                                                                                      | `apps/daemon/server/trpc/platform.ts:296`<br>`apps/daemon/server/trpc/platform.ts:299`<br>`apps/daemon/server/trpc/platform.ts:302`                        |
| `ITERATE_REPO`                      | -               | -/home/iterate/src/github.com/iterate/iterate<br>-$HOME/src/github.com/iterate/iterate<br>/home/iterate/src/github.com/iterate/iterate | `sandbox/after-repo-sync-steps.sh:4`<br>`sandbox/after-repo-sync-steps.sh:6`<br>`sandbox/after-repo-sync-steps.sh:8`                                       |
| `LOCAL_DOCKER_REPO_CHECKOUT`        | -               | -                                                                                                                                      | `apps/os/alchemy.run.ts:493`<br>`apps/os/alchemy.run.ts:524`<br>`apps/os/alchemy.run.ts:524`                                                               |
| `LOCAL_DOCKER_SYNC_FROM_GIT_TARGET` | -               | -                                                                                                                                      | `sandbox/sync-repo-from-git-remote.sh:5`                                                                                                                   |
| `DOCKER_HOST_GIT_BRANCH`            | -               | -                                                                                                                                      | `apps/os/alchemy.run.ts:490`<br>`apps/os/alchemy.run.ts:507`<br>`apps/os/alchemy.run.ts:520`                                                               |
| `DOCKER_HOST_GIT_COMMIT`            | -               | -                                                                                                                                      | `apps/os/alchemy.run.ts:489`<br>`apps/os/alchemy.run.ts:505`<br>`apps/os/alchemy.run.ts:519`                                                               |
| `DOCKER_HOST_GIT_COMMON_DIR`        | -               | -/host/commondir                                                                                                                       | `apps/os/alchemy.run.ts:488`<br>`apps/os/alchemy.run.ts:503`<br>`apps/os/alchemy.run.ts:518`                                                               |
| `DOCKER_HOST_GIT_DIR`               | -               | -/host/gitdir                                                                                                                          | `apps/os/alchemy.run.ts:487`<br>`apps/os/alchemy.run.ts:501`<br>`apps/os/alchemy.run.ts:517`                                                               |
| `DOCKER_HOST_GIT_REPO_ROOT`         | -               | -                                                                                                                                      | `apps/os/alchemy.run.ts:486`<br>`apps/os/alchemy.run.ts:499`<br>`apps/os/alchemy.run.ts:516`                                                               |

## Workflow env keys only (not elsewhere)

| Var                           | Doppler configs |
| ----------------------------- | --------------- |
| `IMAGE_NAME`                  | -               |
| `PLAYWRIGHT_JSON_OUTPUT_FILE` | -               |
| `SANDBOX_ITERATE_REPO_REF`    | -               |

## Referenced vars not in Doppler

- `AGENT`
- `ALLOWED_DOMAINS`
- `APP_URL`
- `CI`
- `CLAUDE_CODE`
- `CLAUDE_DOPPLER_TOKEN`
- `CLOUDFLARE_TUNNEL_HOSTNAME`
- `CLOUDFLARE_TUNNEL_URL`
- `CRON_TASK_INTERVAL_MS`
- `CUSTOM_VAR`
- `DAEMON_NAME`
- `DATABASE_URL`
- `DAYTONA_DEFAULT_AUTO_DELETE_MINUTES`
- `DAYTONA_DEFAULT_AUTO_STOP_MINUTES`
- `DAYTONA_DEFAULT_SNAPSHOT`
- `DEV`
- `DOCKER_TUNNEL_PORTS`
- `DOCKER_COMPOSE_PROJECT_NAME`
- `DOCKER_HOST`
- `DOCKER_DEFAULT_IMAGE`
- `DOCKER_DEFAULT_SERVICE_TRANSPORT`
- `DOCKER_HOST_SYNC_ENABLED`
- `DOPPLER_TOKEN`
- `FLY_API_TOKEN`
- `FLY_BASE_DOMAIN`
- `FLY_DEFAULT_IMAGE`
- `FLY_NETWORK`
- `FLY_DEFAULT_REGION`
- `GIT_SHA`
- `GITHUB_ENV`
- `GITHUB_OUTPUT`
- `GITHUB_STEP_SUMMARY`
- `HOSTNAME`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ITERATE_BOT_GITHUB_TOKEN`
- `ITERATE_CUSTOMER_REPO_PATH`
- `ITERATE_EGRESS_PROXY_URL`
- `ITERATE_MACHINE_ID`
- `ITERATE_OS_API_KEY`
- `ITERATE_OS_BASE_URL`
- `ITERATE_REPO`
- `ITERATE_RESEND_API_KEY`
- `ITERATE_RESEND_FROM_ADDRESS`
- `ITERATE_SKIP_PROXY`
- `KEEP_SANDBOX_CONTAINER`
- `KEEP_WORKTREE`
- `LOCAL_DOCKER_COMPOSE_PROJECT_NAME`
- `LOCAL_DOCKER_IMAGE_NAME`
- `LOCAL_DOCKER_NEON_PROXY_PORT`
- `LOCAL_DOCKER_POSTGRES_PORT`
- `LOCAL_DOCKER_REPO_CHECKOUT`
- `LOCAL_DOCKER_SYNC_FROM_GIT_TARGET`
- `NEEDS`
- `NODE_ENV`
- `NODE_VERSION`
- `NVM_DIR`
- `ONLY_THIS`
- `OPENCODE`
- `OPENCODE_SESSION`
- `PATH`
- `PIDNAP_ACTION`
- `PIDNAP_AUTH_TOKEN`
- `PIDNAP_INPUT_B64`
- `PIDNAP_RPC_URL`
- `PLAYWRIGHT_PLUGIN_DEBUG`
- `PNPM_HOME`
- `PNPM_VERSION`
- `PORT`
- `PROXY_WORKER`
- `PSCALE_DATABASE_URL`
- `REGISTRY_IMAGE_NAME`
- `REQUIRE_CLOUDFLARE_TUNNEL_TEST_SUCCESS`
- `RUN_DOCKER_CLOUDFLARE_TUNNEL_TESTS`
- `RUN_SANDBOX_TESTS`
- `SANDBOX_BUILD_PLATFORM`
- `SANDBOX_BUN_VERSION`
- `SANDBOX_CLAUDE_CODE_VERSION`
- `SANDBOX_CODEX_VERSION`
- `SANDBOX_DAYTONA_ENABLED`
- `SANDBOX_DEPOT_SAVE_TAG`
- `DOCKER_HOST_GIT_BRANCH`
- `DOCKER_HOST_GIT_COMMIT`
- `DOCKER_HOST_GIT_COMMON_DIR`
- `DOCKER_HOST_GIT_DIR`
- `DOCKER_HOST_GIT_REPO_ROOT`
- `SANDBOX_ENTRY_ARGS`
- `SANDBOX_FLY_REGISTRY_APP`
- `SANDBOX_GO_VERSION`
- `SANDBOX_GOGCLI_REF`
- `SANDBOX_MACHINE_PROVIDERS`
- `SANDBOX_OPENCODE_VERSION`
- `SANDBOX_PI_CODING_AGENT_VERSION`
- `SANDBOX_PUSH_FLY_REGISTRY`
- `SANDBOX_PUSH_FLY_REGISTRY_MAIN`
- `SANDBOX_TEST_BASE_DAYTONA_SNAPSHOT`
- `SANDBOX_TEST_BASE_DOCKER_IMAGE`
- `SANDBOX_TEST_BASE_FLY_IMAGE`
- `SANDBOX_TEST_PROVIDER`
- `SANDBOX_TEST_SNAPSHOT_ID`
- `SANDBOX_USE_DEPOT_REGISTRY`
- `SELF`
- `SHELL`
- `SKIP_DOPPLER_CHECK`
- `SLACK_BOT_TOKEN`
- `STAGE`
- `STARTUP_DELAY`
- `UBUNTU_CODENAME`
- `UPSTREAM`
- `VIDEO_MODE`
- `VITE_APP_STAGE`
- `VITE_DAYTONA_DEFAULT_SNAPSHOT`
- `VITE_POSTHOG_PROXY_URL`
- `VSCODE_CWD`
- `WORKER_LOADER`

## Doppler vars not referenced in code

- `ALCHEMY_STATE_TOKEN`
- `ALLOW_SIGNUP_FROM_EMAILS`
- `BIOS_BUILDER_BOX_URL`
- `BRAINTRUST_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CURSOR_API_KEY`
- `DEPOT_ORG_ID`
- `DEPOT_PROJECT`
- `DEPOT_PROJECT_ID`
- `DEPOT_TOKEN`
- `DOPPLER_ENVIRONMENT`
- `DOPPLER_PROJECT`
- `DRIZZLE_ADMIN_POSTGRES_CONNECTION_STRING`
- `DRIZZLE_RW_POSTGRES_CONNECTION_STRING`
- `E2B_ACCESS_TOKEN`
- `E2B_API_KEY`
- `EXA_API_KEY`
- `EXPIRING_URLS_SIGNING_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_ESTATES_DEFAULT_INSTALLATION_ID`
- `GITHUB_ESTATES_TOKEN`
- `GITHUB_READ_REPO`
- `GOOGLEWORKSPACE_CLIENT_ID`
- `GOOGLEWORKSPACE_CLIENT_SECRET`
- `INTEGRATIONS_PROXY_URL`
- `ITERATE_ADMIN_DOMAINS`
- `ITERATE_MOCK_SERVER_CLIENT_ID`
- `ITERATE_MOCK_SERVER_SECRET`
- `ITERATE_NOTIFICATION_ESTATE_ID`
- `ITERATE_TEST_USER_PATTERNS`
- `LINEAR_CLIENT_ID`
- `LINEAR_CLIENT_SECRET`
- `LOGO_DEV_PUBLISHABLE_KEY`
- `LOGO_DEV_SECRET_KEY`
- `NGROK_AUTH_TOKEN`
- `NOTION_CLIENT_ID`
- `NOTION_CLIENT_SECRET`
- `ONBOARDING_E2E_TEST_SETUP_PARAMS`
- `PARALLEL_AI_API_KEY`
- `PLANETSCALE_API_TOKEN`
- `PLANETSCALE_ORGANIZATION`
- `PLANETSCALE_PROD_POSTGRES_URL`
- `POSTHOG_KEY`
- `PROJECT_NAME`
- `RESEND_ALPHAITERATECOM_API_KEY`
- `RESEND_ALPHAITERATECOM_WEBHOOK_SECRET`
- `RESEND_GARPLECOM_API_KEY`
- `FLY_DEFAULT_CPUS`
- `FLY_DEFAULT_MEMORY_MB`
- `SERVICE_AUTH_TOKEN`
- `SLACK_APP_ID`
- `STRIPE_PRICING_PLAN_ID`
- `STRIPE_PRODUCT_ID`
- `TEMPLATE_ESTATE_SYNC_TOKEN`
- `VITE_ENABLE_TEST_ADMIN_USER`
- `VITE_ITERATE_USER`
- `VITE_TEST_ADMIN_CREDENTIALS`
- `VITE_USE_MOCK_OAUTH`
- `XAI_API_KEY`

## Consolidation plan

### Phase 0: correctness fixes (do now)

- Add missing required runtime secrets in `stg`: `DAYTONA_API_KEY`, `GITHUB_APP_SLUG`, `RESEND_BOT_DOMAIN`, `ENCRYPTION_SECRET`.
- Keep `APP_STAGE` and `VITE_APP_STAGE` out of Doppler if desired; they are force-set in code before validation (`apps/os/alchemy.run.ts`).

### Phase 1: choose source of truth per variable class

- `Doppler-owned` (env-specific values/secrets): keep only in Doppler, avoid code defaults except bootstrap-safe local fallback.
- `Code-owned` (local/test/bootstrap mechanics): keep defaults in source; do not mirror in Doppler.
- `Build-owned` (Dockerfile `ARG` pins/toolchain versions): keep in source control; optionally duplicate in Doppler only if you need runtime overrides.

### Phase 2: move selected defaults from code to Doppler

- Candidates currently defaulted in code but likely env policy knobs:
  `DAYTONA_DEFAULT_AUTO_STOP_MINUTES`, `DAYTONA_DEFAULT_AUTO_DELETE_MINUTES`, `SIGNUP_ALLOWLIST`, `FLY_DEFAULT_REGION`, `FLY_BASE_DOMAIN`.
- If you want Doppler-only defaults, set explicit values in all `dev/stg/prd`, then remove code `.default(...)`/fallback for those vars.

### Phase 3: reduce dead/duplicate config

- Review `Doppler vars not referenced in code` and either:
  1. map each to an owning file/feature, or
  2. deprecate and delete.
- Start with likely stale keys: `FLY_DEFAULT_CPUS`, `FLY_DEFAULT_MEMORY_MB`, `PROJECT_NAME`, `POSTHOG_KEY`, `STRIPE_PRICING_PLAN_ID`, `STRIPE_PRODUCT_ID`, `VITE_*_TEST_*`.

### Phase 4: codify and enforce

- Add a single machine-readable env contract file (e.g. `config/env-contract.ts`) with owner, scope, required/default, and whether Doppler-managed.
- Add CI check to diff:
  1. referenced vars in source,
  2. contract vars,
  3. Doppler keys for `dev/stg/prd`.
- Fail CI on new unowned vars, missing required vars, and orphan Doppler keys (after an allowlist grace period).
