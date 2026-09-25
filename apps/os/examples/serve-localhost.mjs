// examples/serve-localhost.mjs — `iterate tunnel` without the CLI: serve a local port on a project
// host, WebSockets included, in one capnweb session. Lend the project a fetch-shaped RpcTarget, set a
// fetch route whose target is it, print the URL; Ctrl-C deletes the route.
//
//   npm install capnweb@npm:@iterate-com/capnweb
//   ITERATE_BEARER_TOKEN=… node serve-localhost.mjs https://os.iterate.com my-project blog 5173
//
// Credentials come from the environment: ITERATE_BEARER_TOKEN (a personal access token), or an
// operator's APP_CONFIG_ADMIN_API_SECRET. The visitor's path is forwarded as-is: under paths routing
// (`<origin>/projects/<project>/<routingSlug>/…`, a per-PR preview) the platform strips that base and
// names it in `x-iterate-base-path`, so a local server that serves under it (Vite: `--base`) needs it
// put back in front. Pinned by apps/os e2e/serve-localhost-example.e2e.test.ts.
import {
  newWebSocketRpcSession,
  RpcTarget,
  upgradeWebSocketResponse,
  WebSocketPair,
} from "capnweb";

const [origin, projectSlug, routingSlug, port] = process.argv.slice(2);
const api = newWebSocketRpcSession(`${origin.replace(/^http/, "ws")}/api`);
const session = api.authenticate(
  process.env.ITERATE_BEARER_TOKEN
    ? { type: "bearer", token: process.env.ITERATE_BEARER_TOKEN }
    : { type: "admin-secret", secret: process.env.APP_CONFIG_ADMIN_API_SECRET },
);
const project = session.projects.get(projectSlug);

class LocalSite extends RpcTarget {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean);
      const local = new WebSocket(`ws://localhost:${port}${url.pathname}${url.search}`, protocols);
      local.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => {
        local.onopen = resolve;
        local.onerror = reject;
      });
      const pair = new WebSocketPair(); // not iterable
      const [visitor, ours] = [pair[0], pair[1]];
      ours.accept();
      ours.addEventListener("message", (event) => local.send(event.data));
      ours.addEventListener("close", () => local.close());
      local.onmessage = (event) => ours.send(event.data);
      local.onclose = () => ours.close();
      return upgradeWebSocketResponse(visitor, {
        headers: { "Sec-WebSocket-Protocol": local.protocol },
      });
    }
    return fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: "half",
    });
  }
}

const fetchRouteName = `tunnel-${routingSlug}`;
await project.provide(`itx.tunnels.${routingSlug}`, new LocalSite());
await project.fetchRoutes.set(fetchRouteName, {
  requestMatcher: { routingSlug },
  target: `itx.tunnels.${routingSlug}`,
  authRequirement: null,
});
console.log(await project.url({ routingSlug }));
process.once("SIGINT", async () => {
  await project.fetchRoutes.set(fetchRouteName, null);
  api[Symbol.dispose]();
  process.exit(0);
});
