# The iterate CLI

The `iterate` command for Iterate (`core/os`). Requires Node >=22.18; no Bun runtime. It is
part of the SDK's package, [`iterate`](../../README.md). `npm install -g iterate` installs
the `iterate` command the examples below use.

```sh
npx iterate                               # offline help
npx iterate login                         # browser OAuth with project consent
npx iterate projects list
npx iterate orgs list
npx iterate ping
npx iterate repl --project my-project     # local Node REPL
npx iterate itx run --project my-project --eval 'return await itx.whoami();'
npx iterate tokens create --name my-script --project my-project   # a personal access token
npx iterate tokens list
npx iterate tokens revoke pat_…
npx iterate mcp claude                    # Claude Code on /mcp with ITERATE_BEARER_TOKEN
npx iterate use-my-computer --project my-project --name myComputer
npx iterate tunnel 5173 --project my-project --name blog  # a local port on a project host
npx iterate provide ./whatsapp.ts --project my-project  # a local file's functions as itx.whatsapp
npx iterate menubar --project my-project  # macOS app
npx iterate logout
```

The default server is `https://os.iterate.com`. Login uses that server's OAuth
issuer, PKCE and a loopback callback, and asks for the `iterate` scope alone.
Tokens refresh automatically before a command when close to expiry.
`ITERATE_BEARER_TOKEN` supplies a personal access token for scripts and
`mcp claude` (`tokens create` prints one once; it works at `/api`, `/mcp` and the
projects' hosts). `APP_CONFIG_SECRETS__ADMIN_BEARER` supplies the operator's
credentials, which only `/api` accepts, and takes precedence. The `tokens`
commands use neither, nor the stored login: each signs in in the browser with the
`account` scope for its one call and ends that sign-in, so a stored login mints
no key. `mcp claude` prints a command that reads the key from
`$ITERATE_BEARER_TOKEN`, never the key itself. See
[credentials](../../../os/docs/credentials.md).
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
iterate tunnel 3000 --project my-project --name hello --hostname hello.tunnels.example.com
# https://hello.tunnels.example.com/ → http://localhost:3000 (project members only). Press Ctrl-C to stop.
```

The URL alone goes to stdout; everything else goes to stderr. The tunnel lends the local port to
the project as `itx.tunnels.<name>` with the fetch route `tunnel-<name>` (`itx.fetchRoutes`)
whose target is it. The route matches the name's host (`requestMatcher: { routingSlug }`), or
with `--hostname` that one hostname of the project alone (`url: { hostname }`). The project's
config worker forwards a matched request to the route's target (`core/configs/default/worker.ts`). By default only signed-in project members get through; others are
sent to sign in. The route lives as long as the lend: Ctrl-C deletes it, and a tunnel that dies
without it (killed, asleep, offline) leaves the host answering 502 until the platform notices,
then the route is gone too, until the tunnel runs again.

On a deployment that serves projects under paths (`/projects/<project>/<name>/` on the
platform's own origin, such as a per-PR preview), the local server must serve under the printed
base path (Vite: `--base`). A deployment with a domain gives each tunnel its own origin:
[custom domain](../../../os/SELF-HOSTING.md#custom-domain-own-origins-for-apps-and-tunnels).

### Without the CLI

A tunnel is one capnweb session: lend the project a fetch-shaped `RpcTarget` with a fetch route
to it (`provide`'s `fetchRoute`, which ends with the lend), and delete the route on exit.
[core/os/examples/serve-localhost.mjs](../../../os/examples/serve-localhost.mjs) is the whole
thing, runnable (`npm install capnweb@npm:@iterate-com/capnweb`):

```js
class LocalSite extends RpcTarget {
  async fetch(request) {
    const url = new URL(request.url);
    // a WebSocket upgrade: dial ws://localhost:<port>, bridge it through a WebSocketPair and answer
    // upgradeWebSocketResponse(visitor, { headers: { "Sec-WebSocket-Protocol": local.protocol } })
    // Node's fetch decodes a compressed body but keeps its content-encoding: ask for none
    const headers = new Headers(request.headers);
    headers.set("accept-encoding", "identity");
    return fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
    });
  }
}
// the route rides the lend: set again when the platform re-attaches it, gone when it ends
await project.provide(`itx.tunnels.${routingSlug}`, new LocalSite(), {
  fetchRoute: {
    fetchRouteName: `tunnel-${routingSlug}`,
    requestMatcher: { routingSlug },
    authRequirement: null,
  },
});
console.log(await project.url({ routingSlug }));
```

## Provide

`provide <file>` lends a local file's functions to a project as `itx.<name>` until Ctrl-C, for
code that has to run on this computer: a device on its network, a session tied to its IP, local
state. The file is `.ts`, `.mts`, `.mjs` or `.js` alike, imported by Node itself (which strips a
TypeScript file's types), and its default export answers the functions:

```ts
// whatsapp.ts
import makeWASocket from "baileys"; // from this file's own folder's node_modules

export const description = "My WhatsApp: sendMessage(jid, content) …"; // the line a model reads

let socket; // module scope lives as long as the process, across reconnects
export default function provide({ itx }) {
  // called on every connection with that connection's project
  socket ??= makeWASocket({/* … */});
  return {
    sendMessage: (jid, content) => socket.sendMessage(jid, content),
    async note(text) {
      await itx.append({ type: "whatsapp/note-added", payload: { text } });
    },
  };
}
```

```sh
iterate provide ./whatsapp.ts --project my-project           # itx.whatsapp (the file's name)
iterate provide ./dummy.ts --name whatsappDummy --project my-project
```

`itx.<name>` alone goes to stdout once it is live; everything else goes to stderr. The project's
scripts and agents call it like any capability (`await itx.whatsapp.sendMessage(…)`); the file
reaches the project through the `itx` it was handed.

- **Dependencies are the file's folder's.** Node resolves the file's bare imports from its own
  folder's `node_modules`, never the CLI's: install them there first (`npm install`, `pnpm
install`). A missing one is refused before any sign-in, naming the folder to install in. The CLI
  installs nothing.
- **Plain functions, no capnweb.** The CLI wraps the functions in its own `RpcTarget`: capnweb lends
  only its own copy's, which a file's own `capnweb` install is not. A plain object's own functions
  are lent, or a class instance's methods (never its fields). Arguments and answers cross as they
  are, so they must be plain data, bytes or stubs.
- **Every connection calls it again.** The CLI reconnects when its connection closes or the lend
  ends under it (for about five minutes, as `tunnel` does), calls the default export with the new
  connection's project, and lends the answer at the same name. Keep long-lived state in module
  scope and reach the project through the newest `itx`.
- **Share only with a project you trust.** Its callers run the file's functions with this
  computer's authority. A killed or stopped `provide` takes the name with it: the project's calls
  answer `NO_ITX_EXPRESSION_MATCH`, as before it was lent.

For a machine that stays up, give it a key of its own rather than the stored login (whose grant
lasts 30 days at most): `ITERATE_BEARER_TOKEN` from `iterate tokens create --name whatsapp
--project my-project --never-expires`.

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
