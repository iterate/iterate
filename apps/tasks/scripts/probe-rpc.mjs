// Agent-lane probe for the vessel's capnweb API root: hold a LIVE WebSocket
// RPC session against `/api` (exactly what a config worker's
// `itx.worker.tasks` getter will hold), authenticate with an explicit
// project-app-session token, and drive a checkout — while a stock Yjs
// client sits in the same checkout proving the agent's edits arrive live
// and human edits merge back.
//   node probe-rpc.mjs <baseUrl> <projectId> <token> <checkoutId>
// baseUrl may be the vessel host (tasks.iterate.workers.dev) or a project
// host (tasks--<slug>.iterate.app) — the RPC lane works on both.
import { WebSocket as NodeWebSocket } from "ws";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { newWebSocketRpcSession } from "capnweb";

const [baseUrl, projectId, token, checkoutId] = process.argv.slice(2);
if (!baseUrl || !projectId || !token || !checkoutId) {
  throw new Error("usage: probe-rpc.mjs <baseUrl> <projectId> <token> <checkoutId>");
}
const base = new URL(baseUrl);

const until = async (label, predicate, timeoutMs = 30_000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.log(`ok: ${label}`);
};

// --- the human: a stock Yjs collaborator in the same checkout ---------------
class AuthedWebSocket extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, {
      headers: { cookie: `iterate-project-auth=${token}`, "x-itx-project-id": projectId },
    });
  }
}
const humanDoc = new Y.Doc();
const human = new YProvider(base.host, checkoutId, humanDoc, {
  prefix: `/yjs/${encodeURIComponent(checkoutId)}`,
  protocol: base.protocol === "https:" ? "wss" : "ws",
  WebSocketPolyfill: AuthedWebSocket,
  disableBc: true,
});
const humanFiles = () => humanDoc.getMap("files");
const humanMeta = () => humanDoc.getMap("meta");

// --- the agent: a live capnweb session on /api -------------------------------
const wsUrl = new URL("/api", base);
wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const socket = new NodeWebSocket(wsUrl.toString());
const api = newWebSocketRpcSession(socket);

// Pipelined: authenticate → project stub, no explicit await needed between.
const project = api.authenticate(token);
console.log("projectId:", await project.projectId());
console.log("repos:", await project.repos());

const checkout = project.checkout(checkoutId);
const snapshot = await checkout.files();
console.log(
  `checkout @ ${snapshot.baseCommit.slice(0, 7)} with ${Object.keys(snapshot.files).length} files`,
);
if (!snapshot.baseCommit) throw new Error("checkout did not seed a base commit");

await until("human synced + seeded", () => {
  return human.synced && typeof humanMeta().get("baseCommit") === "string";
});

// Agent writes a task; the human's live doc must see it (no reload, no poll).
const agentPath = `tasks/agent-probe-${Date.now()}.md`;
await checkout.write(
  agentPath,
  `---\nstate: todo\n---\n\n# Written by the RPC agent\n\nvia capnweb /api\n`,
);
await until("human sees the agent's new task live", () => humanFiles().has(agentPath));

// Human types into the SAME file; the agent must read the merged result.
humanFiles().get(agentPath).insert(humanFiles().get(agentPath).length, "\nhuman-line\n");
await until("agent reads the human's line back", async () => {
  const content = await checkout.read(agentPath);
  return content !== null && content.includes("human-line");
});

const changes = await checkout.changes();
console.log("changes:", JSON.stringify(changes));
if (!changes.some((change) => change.path === agentPath && change.status === "added")) {
  throw new Error("agent write missing from the change summary");
}

const result = await checkout.commit("Agent probe: task written over capnweb RPC");
console.log("committed:", JSON.stringify(result));
await until(
  "human sees the new base commit",
  () => humanMeta().get("baseCommit") === result.commitOid,
);

// Tidy up after ourselves so probe files don't pile up in the repo: delete
// the probe task and commit the deletion through the same stub.
await checkout.delete(agentPath);
const cleanup = await checkout.commit("Agent probe: clean up probe task");
console.log("cleanup commit:", JSON.stringify(cleanup));

human.destroy();
socket.close();
console.log("agent lane: all green");
process.exit(0);
