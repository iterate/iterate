# iterate

CLI for OS Next (`apps/os-next`). Requires Node >=22.15; no Bun runtime.

```sh
npx iterate                       # offline help
npx iterate login                 # browser OAuth with project consent
npx iterate projects list
npx iterate orgs list
npx iterate ping
npx iterate itx run --project my-project --eval 'return await itx.whoami();'
npx iterate use-my-computer --project my-project --name myComputer
npx iterate logout
```

The default server is `https://os.iterate2.com`. Login uses that server's OAuth
issuer, PKCE and a loopback callback. Tokens refresh automatically before a
command when close to expiry. `ITERATE_BEARER_TOKEN` supplies a token for scripts;
`APP_CONFIG_ADMIN_API_SECRET` supplies operator credentials and takes precedence.
`ITERATE_SKIP_BROWSER_OPEN=1` prints the login URL without opening a browser.

## Running scripts

`itx run` executes a JavaScript function body on OS Next with `itx` in scope.
Use `return` for the result. The server records the run and its settlement;
the CLI never retries a script automatically. Scripts execute on the server,
so local Node APIs and local filesystem access are unavailable.

```sh
iterate itx run --project my-project --context /notes --eval '
  await itx.append({ type: "note", payload: { text: "hello" } });
  return await itx.readEvents(0, 10);
'
iterate itx run --project my-project --file ./script.js
cat script.js | iterate itx run --project my-project --file -
```

Specify exactly one of `--eval` or `--file`. `--context` is a project-local path
(default `/`). `--project` accepts an id or slug; otherwise the CLI uses the
config's `defaultProject`, or the only project accessible to the session.

## Use my computer

`use-my-computer` shares a Mac as a live OS Next capability until Ctrl-C:

- `itx.myComputer.ask({ question, buttons? })`: native choice dialog.
- `itx.myComputer.notify({ message, title? })`: desktop notification.
- `itx.myComputer.runSwift({ code })`: Swift with the owner's local permissions.
- `itx.myComputer.__describe()`: usage instructions and method signatures.

The command requires macOS, AppleScript and Swift. Share only with a project
you trust: its callers can run local code. The capability belongs to the live
connection and is released on exit. A disconnect or token expiry ends sharing
with an error; rerun the command to refresh authentication and reconnect.

## Configs and migration

Configs live in `${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`. Selection
order is `--config`, a parent-directory workspace mapping, the default config,
a single saved config, then built-in `prd`.

```sh
iterate config set --name next --os-base-url https://os.iterate2.com \
  --default-project my-project --set-default
iterate --config next login
iterate config set --name local --os-base-url http://localhost:8787 --set-workspace
iterate config list
iterate config get
```

Existing configs keep their server URL. For a config that targets the old OS,
set its `--os-base-url` to an OS Next deployment and log in again. Changing the
server clears that config's session. There is no separate `authBaseUrl` setting.

The old chat TUI, egress approver, menu-bar app and remotely discovered
`iterate os ...` commands have been removed. Use `iterate itx run` for scripts;
its `--project` selects the project and `--context` selects a path within it.
Legacy SDK exports remain available for apps that still use the original OS.

## Node connections

`iterate/next/node` exposes a connection owner for OS Next scripts and live
providers. It uses the same protocol and cleanup as the CLI:

```js
import { connectOsNext } from "iterate/next/node";

using connection = await connectOsNext({
  baseUrl: "https://os.iterate2.com",
  auth: { type: "bearer", token: process.env.ITERATE_BEARER_TOKEN },
});
using project = await connection.session.projects.get("my-project");
console.log(await project.run("async (itx) => await itx.whoami()"));
```

The package launcher delegates to repository source during development and
uses the published build when installed through `npx`.
