# iterate

CLI for Iterate.

`npx iterate` opens the Iterate chat terminal UI. It is equivalent to
`npx iterate chat`.

The package also runs as a thin bootstrapper: inside this repo it delegates to
the local `packages/iterate` source, and from npm it runs the published build.

## Requirements

- Node `>=22`
- Bun, for the current OpenTUI-based chat terminal runtime

## Quick start

Run without installing globally:

```bash
npx iterate
```

If you are not logged in yet, `iterate chat` starts the browser OAuth flow. The
auth flow asks for project access and can create your first organization and
project before returning to the CLI.

```bash
npx iterate chat
```

For help and other commands:

```bash
npx iterate --help
npx iterate login
npx iterate orgs list
npx iterate config list
```

## Commands

- `iterate` - open chat
- `iterate chat` - open the Iterate agent chat terminal UI
- `iterate login` - authenticate with browser-based OAuth
- `iterate logout` - remove the stored session for the current config
- `iterate orgs list`
- `iterate config ...`
- `iterate os ...`

## Config file

Config path:

`${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`

Config shape:

```json
{
  "configs": {
    "default": {
      "osBaseUrl": "https://os.iterate.com",
      "authBaseUrl": "https://auth.iterate.com",
      "defaultProject": "my-project"
    },
    "dev": {
      "osBaseUrl": "http://localhost:54896",
      "authBaseUrl": "http://localhost:7101"
    }
  },
  "default": "default",
  "workspaces": {
    "/absolute/workspace/path": "dev"
  }
}
```

Config resolution priority: `--config` flag > workspace match (walk up from cwd) > `default` key > single-config auto-select.

## Local iterate dev

If you run inside an `iterate/iterate` clone, the CLI auto-detects it and
delegates to the local source instead of the published build.

## Publishing (maintainers)

From repo root:

```bash
pnpm --filter ./packages/iterate build
pnpm --filter ./packages/iterate typecheck
pnpm --filter ./packages/iterate test
pnpm exec oxlint packages/iterate/src/cli.ts packages/iterate/src/cli.test.ts
pnpm exec oxfmt --check packages/iterate
pnpm --filter ./packages/iterate publish --access public
```
