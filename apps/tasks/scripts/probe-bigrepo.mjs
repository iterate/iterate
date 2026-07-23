import { WebSocket as NodeWebSocket } from "ws";
import { newWebSocketRpcSession } from "capnweb";
const [baseUrl, projectId, token, checkoutId, repoPath] = process.argv.slice(2);
class AuthedWebSocket extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, {
      headers: { cookie: `iterate-project-auth=${token}`, "x-itx-project-id": projectId },
    });
  }
}
globalThis.WebSocket = AuthedWebSocket;
const wsUrl = new URL("/api", baseUrl);
wsUrl.protocol = "wss:";
using api = newWebSocketRpcSession(wsUrl.toString());
using project = await api.authenticate(token);
const board = project.workspace(checkoutId, repoPath);
const t = Date.now();
try {
  const files = await board.files();
  const paths = Object.keys(files);
  const bytes = Object.values(files).reduce((n, c) => n + (c?.length ?? 0), 0);
  console.log(`files() OK: ${paths.length} files, ${bytes} chars, ${Date.now() - t}ms`);
} catch (error) {
  console.log(`files() FAILED after ${Date.now() - t}ms: ${error?.message ?? error}`);
}
