# iterate

Bootstrap launcher for `npx iterate`.

It does three things:

1. Ensures there is an `iterate/iterate` checkout.
2. Ensures dependencies are installed.
3. Loads `apps/os/backend/trpc/root.ts` from that checkout and proxies calls to `/api/trpc`.

If you run `iterate` from inside an `iterate/iterate` git checkout, the launcher auto-detects that repo and uses it directly. In that mode, auto-install defaults to `false`.

## Repo location

By default the checkout lives at `~/.iterate/repo`.

Resolution order:

1. `ITERATE_REPO_DIR`
2. `workspaces[process.cwd()].repoPath`
3. `global.repoPath`
4. `launcher.repoPath` (legacy)
5. nearest parent directory with `.git`, `pnpm-workspace.yaml`, and `apps/os/backend/trpc/root.ts`
6. `~/.iterate/repo`

You can override with either:

- `ITERATE_REPO_DIR=/path/to/iterate`
- `~/.iterate/.iterate.json`:

```json
{
  "global": {
    "repoPath": "/path/to/iterate"
  }
}
```

## Other launcher options

`~/.iterate/.iterate.json` supports:

- `global.repoRef` / `workspaces[...].repoRef` (branch/tag/sha for fresh clones)
- `global.repoUrl` / `workspaces[...].repoUrl` (custom git remote)
- `global.autoInstall` / `workspaces[...].autoInstall`

Preferred shape now is:

```json
{
  "global": {
    "repoPath": "~/.iterate/repo",
    "autoInstall": true
  },
  "workspaces": {
    "/path/to/workspace": {
      "repoPath": "/path/to/iterate",
      "autoInstall": false
    }
  }
}
```

Launcher resolves config with a shallow merge: `legacy launcher` -> `global` -> `workspaces[process.cwd()]`.

Environment variables override file values:

- `ITERATE_REPO_REF`
- `ITERATE_REPO_URL`
- `ITERATE_AUTO_INSTALL` (`1/true` or `0/false`)

## Setup commands

Use top-level bootstrap commands:

- `iterate setup` prompts for auth (`baseUrl`, `adminPasswordEnvVarName`, `userId`) and launcher config (`repoPath`, `autoInstall`, `scope`)
- `iterate doctor` shows resolved settings and runtime behavior
- `iterate install` forces clone/install for the resolved checkout

`repoPath` accepts real paths, plus shortcuts: `local` (current iterate checkout) and `managed` (`~/.iterate/repo`).

Auth settings always write to `workspaces[process.cwd()]`. Launcher settings write to `global` or `workspaces[process.cwd()]` based on `scope`.

All other commands are executed directly by this package (for example `iterate os ...` and `iterate whoami`).

`iterate launcher ...` still works as a legacy alias.
