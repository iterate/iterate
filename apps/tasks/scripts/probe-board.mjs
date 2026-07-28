// Phase-4 probe: checkout = workspace, end to end through the vessel.
//   board seed  ← workspace.glob + readFile   (no listTaskFiles, no Y.Doc)
//   dirty state ← workspace.gitStatus         (no meta.base anywhere)
//   commit      ← workspace.gitCommit         (live session settles in-barrier)
// A live collab client types mid-flight; the commit must contain its edit.
//   node probe-board.mjs <vesselBaseUrl> <projectId> <token> <checkoutId>
import { WebSocket as NodeWebSocket } from "ws";
import { newWebSocketRpcSession } from "capnweb";
import { ChangeSet } from "@codemirror/state";

const [baseUrl, projectId, token, checkoutId] = process.argv.slice(2);
if (!baseUrl || !projectId || !token || !checkoutId) {
  throw new Error("usage: probe-board.mjs <baseUrl> <projectId> <token> <checkoutId>");
}
const FILE = "/tasks/fault-harness.md";

class AuthedWebSocket extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, {
      headers: { cookie: `iterate-project-auth=${token}`, "x-itx-project-id": projectId },
    });
  }
}
globalThis.WebSocket = AuthedWebSocket;
const wsUrl = new URL("/api", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

const ok = (label) => console.log(`ok: ${label}`);
using api = newWebSocketRpcSession(wsUrl.toString());
using project = await api.authenticate(token);
const board = project.workspace(checkoutId, "/repos/config");

// 1. Board seed from the workspace merged view.
const files = await board.files();
const paths = Object.keys(files);
if (paths.length === 0) throw new Error("board saw no task files");
ok(`board seeded from workspace glob: ${paths.length} task files`);

// 2. Pristine workspace → no dirty entries for a fresh checkout.
const before = await board.status();
ok(`status (pristine or carrying prior PoC edits): ${JSON.stringify(before).slice(0, 120)}`);

// 3. A live collab session edits one card (the "human typing").
const collab = board;
const opened = await collab.open(FILE);
const marker = `board-probe-${Date.now()}`;
const changes = ChangeSet.of(
  { from: opened.content.length, to: opened.content.length, insert: `\n${marker}\n` },
  opened.content.length,
);
const pushed = await collab.push({
  path: FILE,
  baseVersion: opened.version,
  clientId: "board-probe",
  epoch: opened.epoch,
  ops: [{ changes: changes.toJSON(), clientSeq: 0 }],
});
if (pushed.status !== "accepted") throw new Error(`push: ${JSON.stringify(pushed)}`);
ok("live session edit accepted (unsettled keystrokes in the doc)");

// 4. Dirty badge comes from gitStatus — which must BARRIER the live doc.
const dirty = await board.status();
const dirtyText = JSON.stringify(dirty);
if (!dirtyText.includes("fault-harness.md")) {
  throw new Error(`status missed the live edit: ${dirtyText.slice(0, 200)}`);
}
ok("gitStatus settled the live doc and reports the card dirty");

// 5. Commit through the workspace; the live edit must be inside.
const committed = await board.commit(`board probe: live-session edit ${marker}`);
ok(`committed: ${JSON.stringify(committed).slice(0, 140)}`);

// 6. The overlay cleared: board still shows the content (now from the mount),
//    status is clean for that file, and the log has our commit.
const after = await board.files();
if (!Object.keys(after).some((candidate) => candidate.includes("fault-harness"))) {
  throw new Error("committed file vanished from the board");
}
const post = JSON.stringify(await board.status());
if (post.includes("fault-harness.md")) {
  throw new Error(`overlay did not clear after commit: ${post.slice(0, 200)}`);
}
const log = JSON.stringify(await board.log(3));
if (!log.includes("board probe")) throw new Error(`commit missing from log: ${log.slice(0, 200)}`);
// The assertion that matters: the COMMITTED content (read now falls through
// to the mount) contains the exact live-session marker.
const committedText = await board.read(FILE);
if (!committedText || !committedText.includes(marker)) {
  throw new Error("committed content is missing the live-session marker");
}
ok("overlay cleared, commit on main CONTAINS the live edit, reads settle through the mount");

console.log("checkout=workspace: all green");
process.exit(0);
