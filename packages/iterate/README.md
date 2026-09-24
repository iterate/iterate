# iterate

CLI for Iterate (`apps/os`). Requires Node >=22.15; no Bun runtime.

```sh
npx iterate                       # offline help
npx iterate login                 # browser OAuth with project consent
npx iterate projects list
npx iterate orgs list
npx iterate ping
npx iterate repl --project my-project   # local Node REPL
npx iterate itx run --project my-project --eval 'return await itx.whoami();'
npx iterate use-my-computer --project my-project --name myComputer
npx iterate menubar --project my-project   # macOS app
npx iterate logout
```

The default server is `https://os.iterate.com`. Login uses that server's OAuth
issuer, PKCE and a loopback callback. Tokens refresh automatically before a
command when close to expiry. `ITERATE_BEARER_TOKEN` supplies a token for scripts;
`APP_CONFIG_ADMIN_API_SECRET` supplies operator credentials and takes precedence.
`ITERATE_SKIP_BROWSER_OPEN=1` prints the login URL without opening a browser.

## Running scripts

`itx run` executes a JavaScript function body on the platform with `itx` in scope.
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

`use-my-computer` shares a Mac as a live Iterate capability until Ctrl-C:

- `itx.myComputer.ask({ question, buttons? })`: native choice dialog.
- `itx.myComputer.notify({ message, title? })`: desktop notification.
- `itx.myComputer.runSwift({ code })`: Swift with the owner's local permissions.
- `itx.myComputer.__describe()`: usage instructions and method signatures.

The command requires macOS, AppleScript and Swift. Share only with a project
you trust: its callers can run local code. The capability belongs to the live
connection and is released on exit. A disconnect or token expiry ends sharing
with an error; rerun the command to refresh authentication and reconnect.

## Configs

Configs live in `${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`. Selection
order is `--config`, a parent-directory workspace mapping, the default config,
a single saved config, then built-in `prd`.

```sh
iterate config set --name next --os-base-url https://os.iterate.com \
  --default-project my-project --set-default
iterate --config next login
iterate config set --name local --os-base-url http://localhost:8788 --set-workspace
iterate config list
iterate config get
```

Changing a config's server clears its session. The menu bar supports sign-in and
computer sharing. Use `iterate itx run` for scripts; its `--project` selects the
project and `--context` selects a path within it.

## Node REPL

`iterate repl` opens a local Node REPL with the authenticated session as `itx`
(try `await itx.projects.list()`) and the transport's `RpcTarget` constructor.
Pass `--project my-project --context /` to bind `itx` to a project context;
a configured `defaultProject` also selects a project. Top-level `await`, Node APIs and `.load` are available. The bindings remain available after `.clear`; `.exit` releases the context and connection. A lost connection
ends the REPL visibly; it never silently repeats your commands.

## Node connections

`iterate/node` exposes a connection owner for Iterate scripts and live
providers. It uses the same protocol and cleanup as the CLI:

```js
import { connectIterate } from "iterate/node";

using connection = await connectIterate({
  baseUrl: "https://os.iterate.com",
  auth: { type: "bearer", token: process.env.ITERATE_BEARER_TOKEN },
});
using project = await connection.session.projects.get("my-project");
console.log(await project.run("async (itx) => await itx.whoami()"));
```

The package launcher delegates to repository source during development and
uses the published build when installed through `npx`.

## SDK

The SDK exposes context APIs, stream processors, reactive clients, React bindings, and OAuth app sessions under `iterate/*`. The package exports source in this workspace and compiled JavaScript with declarations when packed.
