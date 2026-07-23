// Collab-lane latency probe, both topologies in one script:
//   default   browser → vessel /api → platform workspace DO   (hop (a))
//   --direct  browser → platform /api → workspace DO           (variant (b))
// Client A pushes single-character ops; client B long-polls `wait`. Reports
// push RTT and push→delivery latency distributions over N rounds.
//   node probe-collab.mjs <baseUrl> <projectId> <token> <checkoutId> [rounds] [--direct]
import { WebSocket as NodeWebSocket } from "ws";
import { newWebSocketRpcSession } from "capnweb";
import { ChangeSet } from "@codemirror/state";

const args = process.argv.slice(2).filter((arg) => arg !== "--direct");
const direct = process.argv.includes("--direct");
const [baseUrl, projectId, token, checkoutId, roundsArg] = args;
if (!baseUrl || !projectId || !token || !checkoutId) {
  throw new Error(
    "usage: probe-collab.mjs <baseUrl> <projectId> <token> <checkoutId> [rounds] [--direct]",
  );
}
const ROUNDS = Number(roundsArg ?? 20);
const FILE = "/tasks/design-review.md";

class AuthedWebSocket extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, {
      headers: { cookie: `iterate-project-auth=${token}`, "x-itx-project-id": projectId },
    });
  }
}
globalThis.WebSocket = direct ? NodeWebSocket : AuthedWebSocket;
const wsUrl = new URL("/api", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** One session per "browser", normalized to { open, push(input), wait }. */
function lane(api) {
  if (direct) {
    const ws = api
      .authenticate({ type: "project-app-session", token })
      .projects.get(projectId)
      // Same id derivation as the vessel (checkoutId~repoSlug for
      // /repos/config): both probe lanes must address ONE workspace DO.
      .workspaces.get(`/workspaces/tasks/${checkoutId}~repos--config`);
    return {
      open: () => ws.collab.open(FILE),
      push: (input) => ws.collab.push({ ...input, path: FILE }),
      wait: (epoch, after) => ws.collab.wait(FILE, epoch, after),
    };
  }
  const workspace = api.authenticate(token).workspace(checkoutId, "/repos/config");
  return {
    open: () => workspace.open(FILE),
    push: (input) => workspace.push({ ...input, path: FILE }),
    wait: (epoch, after) => workspace.wait(FILE, epoch, after),
  };
}

using apiA = newWebSocketRpcSession(wsUrl.toString());
using apiB = newWebSocketRpcSession(wsUrl.toString());
const laneA = lane(apiA);
const laneB = lane(apiB);

const openedA = await laneA.open();
console.log(
  `opened (${direct ? "direct" : "vessel hop"}): epoch=${openedA.epoch.slice(0, 8)} version=${openedA.version}`,
);
const openedB = await laneB.open();
if (openedB.epoch !== openedA.epoch) throw new Error("epoch mismatch between clients");

let docLength = openedA.content.length;
let versionA = openedA.version;
let versionB = openedB.version;
const pushRtt = [];
const deliverLatency = [];
// Unique per run: rejoining a durable session with a reused clientId would
// hit the idempotency fast-path and (correctly) drop the "duplicate" seqs.
const clientId = `probe-a-${process.pid}-${Date.now() % 100000}`;

for (let round = 0; round < ROUNDS; round++) {
  const armed = laneB.wait(openedB.epoch, versionB); // armed BEFORE the push
  const changes = ChangeSet.of({ from: 0, to: 0, insert: "." }, docLength);
  const startedAt = Date.now();
  const pushed = await laneA.push({
    baseVersion: versionA,
    clientId,
    epoch: openedA.epoch,
    ops: [{ changes: changes.toJSON(), clientSeq: round }],
  });
  const pushedAt = Date.now();
  if (pushed.status !== "accepted") throw new Error(`push: ${JSON.stringify(pushed)}`);
  const delivered = await armed;
  const deliveredAt = Date.now();
  if (delivered.status !== "ops" || delivered.ops.length === 0) {
    throw new Error(`wait returned ${JSON.stringify(delivered).slice(0, 100)}`);
  }
  pushRtt.push(pushedAt - startedAt);
  deliverLatency.push(deliveredAt - startedAt);
  versionA = pushed.version;
  versionB += delivered.ops.length;
  docLength += 1;
}

pushRtt.sort((a, b) => a - b);
deliverLatency.sort((a, b) => a - b);
console.log(`rounds: ${ROUNDS}`);
console.log(
  `push RTT ms       p50=${quantile(pushRtt, 0.5)} p90=${quantile(pushRtt, 0.9)} max=${pushRtt.at(-1)}`,
);
console.log(
  `push→deliver ms   p50=${quantile(deliverLatency, 0.5)} p90=${quantile(deliverLatency, 0.9)} max=${deliverLatency.at(-1)}`,
);
console.log(`collab ${direct ? "direct (b)" : "hop (a)"}: all green`);
process.exit(0);
