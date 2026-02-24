# iterate

⚠️⚠️⚠️ Coming soon! `npx iterate` is a work-in-progress CLI for managing [iterate.com](https://iterate.com) agents ⚠️⚠️⚠️

CLI for Iterate.

Runs as a thin bootstrapper that:

1. Resolves an `iterate/iterate` checkout.
2. Clones/install deps when needed.
3. Loads `apps/os/backend/orpc/root.ts` from that checkout.
4. Exposes commands like `iterate os ...` and `iterate whoami`.

## Requirements

- Node `>=22`
- `git`
- `pnpm` or `corepack`

## Quick start

Run without installing globally:

```bash
npx iterate --help
```

Initial setup (writes auth + launcher config):

```bash
npx iterate setup \
  --os-base-url https://dev-yourname-os.dev.iterate.com \
  --daemon-base-url http://localhost:3001 \
  --admin-password-env-var-name SERVICE_AUTH_TOKEN \
  --user-email dev-yourname@iterate.com \
  --scope global
```

Then run commands:

```bash
npx iterate whoami
npx iterate os project list
```

## Commands

- `iterate setup` - configure auth + launcher defaults
- `iterate doctor` - print resolved config/runtime info
- `iterate install` - force clone/install for resolved checkout
- `iterate whoami`
- `iterate os ...`
- `iterate daemon ...`

`setup --scope global` writes auth + launcher values into `global`; `setup --scope workspace` writes them into `workspaces[process.cwd()]`.

## Config file

Config path:

`${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`

Config shape:

```json
{
  "configs": {
    "default": {
      "osBaseUrl": "https://os.iterate.com",
      "daemonBaseUrl": "http://localhost:3000",
      "auth": {
        "strategy": "device"
      }
    },
    "dev": {
      "osBaseUrl": "https://dev-yourname-os.dev.iterate.com",
      "daemonBaseUrl": "http://localhost:3001",
      "auth": {
        "strategy": "superadmin",
        "adminPasswordEnvVarName": "SERVICE_AUTH_TOKEN",
        "userEmail": "dev-yourname@iterate.com"
      }
    }
  },
  "default": "default",
  "workspaces": {
    "/absolute/workspace/path": "dev"
  }
}
```

Config resolution priority: `--config` flag > workspace match (walk up from cwd) > `default` key > single-config auto-select.

Auth strategies:

- `device` — interactive browser-based login (RFC 8628 device flow). Run `iterate login`.
- `superadmin` — CI/automation impersonation via admin password env var.

## Local iterate dev

If you run inside an `iterate/iterate` clone, the CLI auto-detects it. In that mode, default `autoInstall` is `false`.

You can pin explicitly:

```bash
npx iterate setup \
  --os-base-url https://dev-yourname-os.dev.iterate.com \
  --daemon-base-url http://localhost:3001 \
  --admin-password-env-var-name SERVICE_AUTH_TOKEN \
  --user-email dev-yourname@iterate.com \
  --scope workspace
```

## Publishing (maintainers)

From repo root:

```bash
pnpm --filter ./packages/iterate typecheck
pnpm oxlint packages/iterate/bin/iterate.js
pnpm oxfmt --check packages/iterate
pnpm --filter ./packages/iterate publish --access public
```
