# iterate

⚠️⚠️⚠️ Coming soon! `npx iterate` is a work-in-progress CLI for managing [iterate.com](https://iterate.com) agents ⚠️⚠️⚠️

CLI for Iterate.

Runs as a thin bootstrapper that:

1. Resolves an `iterate/iterate` checkout.
2. Clones/install deps when needed.
3. Loads `apps/os/backend/trpc/root.ts` from that checkout.
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
  --base-url https://dev-yourname-os.dev.iterate.com \
  --admin-password-env-var-name SERVICE_AUTH_TOKEN \
  --user-email dev-yourname@iterate.com \
  --repo-path managed \
  --auto-install true \
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

`setup --scope global` writes auth + launcher values into `global`; `setup --scope workspace` writes them into `workspaces[process.cwd()]`.

## Config file

Config path:

`${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`

Config shape:

```json
{
  "global": {
    "repoPath": "~/.local/share/iterate/repo",
    "repoRef": "main",
    "repoUrl": "https://github.com/iterate/iterate.git",
    "autoInstall": true
  },
  "workspaces": {
    "/absolute/workspace/path": {
      "baseUrl": "https://dev-yourname-os.dev.iterate.com",
      "adminPasswordEnvVarName": "SERVICE_AUTH_TOKEN",
      "userEmail": "dev-yourname@iterate.com",
      "repoPath": "/absolute/path/to/iterate",
      "autoInstall": false
    }
  }
}
```

Merge precedence is shallow:

`global` -> `workspaces[process.cwd()]`

## Repo checkout resolution

`repoPath` resolution order:

1. `ITERATE_REPO_DIR`
2. `workspaces[process.cwd()].repoPath`
3. `global.repoPath`
4. nearest parent directory containing `.git`, `pnpm-workspace.yaml`, and `apps/os/backend/trpc/root.ts`
5. default managed checkout path `${XDG_DATA_HOME:-~/.local/share}/iterate/repo`

`repoPath` shortcuts in `setup`:

- `local` - nearest local iterate checkout
- `managed` - default managed checkout path

Environment overrides:

- `ITERATE_REPO_DIR`
- `ITERATE_REPO_REF`
- `ITERATE_REPO_URL`
- `ITERATE_AUTO_INSTALL` (`1/true` or `0/false`)

## Local iterate dev

If you run inside an `iterate/iterate` clone, the CLI auto-detects it. In that mode, default `autoInstall` is `false`.

You can pin explicitly:

```bash
npx iterate setup \
  --base-url https://dev-yourname-os.dev.iterate.com \
  --admin-password-env-var-name SERVICE_AUTH_TOKEN \
  --user-email dev-yourname@iterate.com \
  --repo-path local \
  --auto-install false \
  --scope workspace
```

## Publishing (maintainers)

From repo root:

```bash
pnpm --filter ./packages/iterate typecheck
pnpm eslint packages/iterate/bin/iterate.js
pnpm prettier --check packages/iterate
pnpm --filter ./packages/iterate publish --access public
```
