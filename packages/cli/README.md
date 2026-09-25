# @iterate-com/cli

The `iterate` command for Iterate (`apps/os`). Requires Node >=22.15; no Bun runtime. It is
built on the SDK, [`iterate`](../iterate/README.md). `npm install -g @iterate-com/cli` installs
the `iterate` command the examples below use.

```sh
npx @iterate-com/cli                               # offline help
npx @iterate-com/cli login                         # browser OAuth with project consent
npx @iterate-com/cli projects list
npx @iterate-com/cli orgs list
npx @iterate-com/cli ping
npx @iterate-com/cli repl --project my-project     # local Node REPL
npx @iterate-com/cli itx run --project my-project --eval 'return await itx.whoami();'
npx @iterate-com/cli tokens create --name my-script --project my-project   # a personal access token
npx @iterate-com/cli tokens list
npx @iterate-com/cli tokens revoke pat_…
npx @iterate-com/cli mcp claude                    # Claude Code on /mcp with ITERATE_BEARER_TOKEN
npx @iterate-com/cli use-my-computer --project my-project --name myComputer
npx @iterate-com/cli tunnel 5173 --project my-project --name blog  # a local port on a project host
npx @iterate-com/cli menubar --project my-project  # macOS app
npx @iterate-com/cli logout
```

The default server is `https://os.iterate.com`. Login uses that server's OAuth
issuer, PKCE and a loopback callback, and asks for the `iterate` scope alone.
Tokens refresh automatically before a command when close to expiry.
`ITERATE_BEARER_TOKEN` supplies a personal access token for scripts and
`mcp claude` (`tokens create` prints one once; it works at `/api`, `/mcp` and the
projects' hosts). `APP_CONFIG_ADMIN_API_SECRET` supplies the operator's
credentials, which only `/api` accepts, and takes precedence. The `tokens`
commands use neither, nor the stored login: each signs in in the browser with the
`account` scope for its one call and ends that sign-in, so a stored login mints
no key. `mcp claude` prints a command that reads the key from
`$ITERATE_BEARER_TOKEN`, never the key itself. See
[credentials](../../apps/os/docs/credentials.md).
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

## Tunnel

`tunnel <port>` serves `http://localhost:<port>` on a host of the project until Ctrl-C,
WebSocket upgrades included (a Vite dev server's hot module reloading works through it):

```sh
iterate tunnel 5173 --project my-project --name blog
# https://blog--my-project.iterate.app → http://localhost:5173 (project members only). Press Ctrl-C to stop.
iterate tunnel 3000 --project my-project --public   # anyone may use it; the name is random
```

The tunnel lends the local port to the project as `itx.tunnels.<name>` and sets the fetch
route `tunnel-<name>` (`itx.fetchRoutes`), which the project's config worker consults first
(the default templates do; an older project adds the lines from `configs/default/worker.ts` to
its own `worker.ts`). By default only signed-in project members get through; others are sent to
sign in. Ctrl-C deletes the route; a tunnel that dies without it leaves the host answering 502
until it runs again. The local server sees `x-forwarded-host` and `x-forwarded-proto`.
`--json` prints the URL and each request as NDJSON.

On a deployment that serves projects under paths (`/projects/<project>/<name>/` on the
platform's own origin, such as a per-PR preview), the local server must serve under the printed
base path (Vite: `--base`). A deployment with a domain gives each tunnel its own origin:
[custom domain](../../apps/os/SELF-HOSTING.md#custom-domain-own-origins-for-apps-and-tunnels).

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

## Development

In this repository `pnpm exec iterate` runs the source (`src/cli.ts`); the launcher uses the
published build when installed through `npx`, or when `ITERATE_FORCE_BUILT_PACKAGE=1`.
