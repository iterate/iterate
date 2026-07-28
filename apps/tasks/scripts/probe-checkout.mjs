// Deployed-lane probe for the collaborative checkout: two headless clients
// join the same checkout with the STOCK y-partyserver provider (the
// y-websocket wire), the way browsers do behind the project proxy (cookie +
// trusted project id header), and verify that edits and presence propagate.
// Optionally commits the diff over a capnweb WebSocket session on /api,
// cookie-authenticated — the same session the browser UI holds. Run from a
// directory whose node_modules has `ws`, `yjs`, `y-partyserver`, `capnweb`.
//   node probe-checkout.mjs <baseUrl> <projectId> <token> <checkoutId> [--commit]
import { WebSocket as NodeWebSocket } from "ws";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { newWebSocketRpcSession } from "capnweb";

const [baseUrl, projectId, token, checkoutId, flag] = process.argv.slice(2);
if (!baseUrl || !projectId || !token || !checkoutId) {
  throw new Error("usage: probe-checkout.mjs <baseUrl> <projectId> <token> <checkoutId> [--commit]");
}
const base = new URL(baseUrl);
const authHeaders = {
  cookie: `iterate-project-auth=${token}`,
  "x-itx-project-id": projectId,
};

/** ws subclass that carries the proxy-stamped auth on the upgrade. */
class AuthedWebSocket extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, { headers: authHeaders });
  }
}

function connect(name) {
  const doc = new Y.Doc();
  const provider = new YProvider(base.host, checkoutId, doc, {
    prefix: `/yjs/${encodeURIComponent(checkoutId)}`,
    protocol: base.protocol === "https:" ? "wss" : "ws",
    WebSocketPolyfill: AuthedWebSocket,
    disableBc: true,
  });
  provider.on("connection-close", (event) =>
    console.log(`${name}: connection closed`, event?.code, event?.reason ?? ""),
  );
  return { name, doc, provider };
}

const until = async (label, predicate, timeoutMs = 30_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`ok: ${label}`);
};

const files = (doc) => doc.getMap("files");
const meta = (doc) => doc.getMap("meta");
const summarize = (doc) =>
  [...files(doc).keys()].sort().map((path) => `${path} (${files(doc).get(path).length}ch)`);

const a = connect("A");
await until(
  "A synced + seeded",
  () => a.provider.synced && typeof meta(a.doc).get("baseCommit") === "string",
);
console.log("A base commit:", meta(a.doc).get("baseCommit").slice(0, 7));
console.log("A sees:", summarize(a.doc));

const b = connect("B");
await until(
  "B synced + seeded",
  () => b.provider.synced && typeof meta(b.doc).get("baseCommit") === "string",
);

// Presence: A announces itself; B should see it.
a.provider.awareness.setLocalStateField("user", { name: "probe-a", color: "#6fbf8f" });
await until("B sees A's presence", () =>
  [...b.provider.awareness.getStates().values()].some((state) => state?.user?.name === "probe-a"),
);

// Collaboration: A adds a task file; B should see it appear.
const path = `tasks/collab-probe-${Date.now()}.md`;
a.doc.transact(() => {
  files(a.doc).set(path, new Y.Text(`---\nstate: todo\n---\n\n# Collab probe\n\nTyped by A.\n`));
});
await until("B sees A's new file", () => files(b.doc).has(path));

// Character-level merge: A and B edit the SAME file concurrently.
files(a.doc).get(path).insert(files(a.doc).get(path).length, "A-line\n");
files(b.doc).get(path).insert(files(b.doc).get(path).length, "B-line\n");
await until(
  "both converge on both edits",
  () =>
    files(a.doc).get(path).toString() === files(b.doc).get(path).toString() &&
    files(a.doc).get(path).toString().includes("A-line") &&
    files(a.doc).get(path).toString().includes("B-line"),
);

if (flag === "--commit") {
  // The browser lane, byte for byte: a capnweb WebSocket session on /api
  // with the session cookie riding the upgrade, authenticate() taking no
  // argument.
  const wsUrl = new URL("/api", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const apiSocket = new AuthedWebSocket(wsUrl.toString());
  const api = newWebSocketRpcSession(apiSocket);
  const project = api.authenticate();
  console.log("repos via cookie lane:", JSON.stringify(await project.repos()));
  const result = await project.checkout(checkoutId).commit("Add collab probe task");
  console.log("committed:", JSON.stringify(result));
  apiSocket.close();
  await until(
    "both see the new base commit",
    () =>
      meta(a.doc).get("baseCommit") === result.commitOid &&
      meta(b.doc).get("baseCommit") === result.commitOid,
  );
} else {
  console.log("skipping commit (pass --commit to exercise it)");
}

console.log("A final view:", summarize(a.doc));
a.provider.destroy();
b.provider.destroy();
process.exit(0);
