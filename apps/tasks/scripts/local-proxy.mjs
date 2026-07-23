// Local stand-in for the config-worker proxy: forwards http://localhost:<port>
// to a tasks vessel (local port OR a deployed https origin), stamping the
// trusted project header + auth cookie the vessel expects. Handles WebSocket
// upgrades (both /yjs and /api lanes need them).
// Usage: node scripts/local-proxy.mjs <listenPort> <targetOrigin> <projectId> <token>
//   targetOrigin: 5199 | http://localhost:5199 | https://tasks-collab-preview.iterate.workers.dev
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const [listenPort, targetArg, projectId, token] = process.argv.slice(2);
if (!listenPort || !targetArg || !projectId || !token) {
  console.error("usage: local-proxy.mjs <listenPort> <targetOrigin> <projectId> <token>");
  process.exit(1);
}
const target = new URL(/^\d+$/.test(targetArg) ? `http://localhost:${targetArg}` : targetArg);
const secure = target.protocol === "https:";
const targetPort = Number(target.port || (secure ? 443 : 80));

const stamp = (headers) => {
  const out = { ...headers, host: target.host, "x-itx-project-id": projectId };
  // Strip any inbound iterate-project-auth (a stale browser cookie would
  // win first-match on the server) — the fresh mint is the only one sent.
  const inbound = (headers.cookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !pair.startsWith("iterate-project-auth="));
  out.cookie = [...inbound, `iterate-project-auth=${token}`].join("; ");
  return out;
};

const server = http.createServer((req, res) => {
  const proxied = (secure ? https : http).request(
    { headers: stamp(req.headers), host: target.hostname, method: req.method, path: req.url, port: targetPort },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on("error", () => res.writeHead(502).end("proxy error"));
  req.pipe(proxied);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = secure
    ? tls.connect(targetPort, target.hostname, { servername: target.hostname })
    : net.connect(targetPort, target.hostname);
  upstream.on(secure ? "secureConnect" : "connect", () => {
    const headers = stamp(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", drop);
  socket.on("error", drop);
});

server.listen(Number(listenPort), "127.0.0.1", () => {
  console.log(`board: http://localhost:${listenPort}  →  ${target.origin}  (project ${projectId})`);
});
