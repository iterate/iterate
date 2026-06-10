# iterate

⚠️⚠️⚠️ Coming soon! `npx iterate` is a work-in-progress CLI for managing [iterate.com](https://iterate.com) agents ⚠️⚠️⚠️

CLI for Iterate. It discovers the OS server's oRPC procedures at runtime and
mounts them as commands under `iterate os ...`, alongside built-in commands for
auth and config management.

When run inside an `iterate/iterate` checkout (or a project with a local
`node_modules` install of `iterate`), the bin delegates to that local copy
instead of the published one.

## Requirements

- Node `>=22`

## Quick start

```bash
npx iterate --help
```

Create a config pointing at a server, then log in:

```bash
npx iterate config set --name prod --os-base-url https://os.iterate.com --set-default
npx iterate login
npx iterate whoami
npx iterate os --help
```

## Commands

- `iterate doctor` — show config file, resolved target, and session status
- `iterate login [--superadmin]` — authenticate (browser device flow, or superadmin impersonation for CI)
- `iterate logout` — remove the stored session for the current config
- `iterate whoami` — show the current authenticated user
- `iterate orgs list` — list organizations from the auth worker
- `iterate config list | set | use | current | local` — manage named configs
- `iterate os ...` — procedures discovered from the configured OS server

Global flags (consumed before command parsing):

- `--config <name>` — use a specific named config
- `--local-router <path>` — mount a local module exporting a named `router` under `local-router`

## Config file

Config path:

`${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`

Config shape:

```json
{
  "configs": {
    "prod": {
      "osBaseUrl": "https://os.iterate.com",
      "auth": { "strategy": "device" }
    },
    "ci": {
      "osBaseUrl": "https://os.iterate.com",
      "auth": {
        "strategy": "superadmin",
        "adminPasswordEnvVarName": "SERVICE_AUTH_TOKEN",
        "userEmail": "someone@example.com"
      }
    }
  },
  "default": "prod",
  "workspaces": {
    "/absolute/workspace/path": "ci"
  }
}
```

Config resolution priority: `--config` flag > workspace match (walk up from cwd) > `default` key > single-config auto-select.

Auth strategies:

- `device` — interactive browser-based login (RFC 8628 device flow). Run `iterate login`.
- `superadmin` — CI/automation impersonation via admin password env var.

`authBaseUrl` is optional. If omitted, the CLI derives it from `osBaseUrl`:

- `os.iterate.com` → `https://auth.iterate.com`
- `localhost` / `127.0.0.1` / `*.iterate-dev.com` → `http://localhost:7101`

## Local iterate dev

To bootstrap a config for local development, run:

```bash
npx iterate config local
```

That creates a `local` config (and sets it as the default and the workspace
config for the current directory) with:

- `osBaseUrl = https://<your-username>.iterate-dev.com`
- `authBaseUrl = http://localhost:7101`

## Publishing (maintainers)

From `packages/iterate`:

```bash
node pubme.js publish --version <version>
```

This bumps the version, checks for a clean git status, and runs `npm publish`
(prompts for your npm OTP).
