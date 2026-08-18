// How long does a quiet WebSocket to the stateless /api worker actually live?
//
// Minimal repro ladder, one ingredient per mode. Expectation under test:
// "hours — it's a normal stateless worker". The soaks measured ~30 s deaths
// (1006) across quiet gaps; each mode adds one ingredient of the soak's shape
// until the killer shows itself:
//
//   silent  bare WebSocket to /api, nothing at all after the upgrade
//   ping    bare WebSocket, WS protocol pings every 15 s (activity control)
//   rpc     capnweb session, authenticate + one RPC, then true silence
//   open    rpc + streams.get(fresh path) + openConnection + one durable
//           append delivered back, then true silence — the DO now retains a
//           callback into this socket while everything goes quiet
//   mount   a fake DEVICE: projects.connect with a live capability, then
//           silence. The close code is the mount invariant's instrument —
//           kill the client scope's stream from another shell and this
//           socket must close 4901 within moments, never sit unreachable.
//
// The raw socket's close event is the entire instrument: its code, reason and
// elapsed time say who hung up and when. Nothing probes, so nothing generates
// traffic that would reset an idle clock. Run one mode per process:
//
//   doppler run --config preview_3 -- npx tsx scripts/voicelab/socket-lifetime.ts open
import process from "node:process";
import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";

const mode = process.argv[2] ?? "silent";
const base = process.env.APP_CONFIG_BASE_URL ?? "https://os.iterate-preview-3.com";
const url = `${base.replace(/^http/, "ws")}/api`;
const startedAt = Date.now();
const stamp = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

const socket = new WebSocket(url, { handshakeTimeout: 15_000 });
socket.on("close", (code, reason) => {
  console.log(`[${mode}] CLOSED at ${stamp()} code=${code} reason=${String(reason).slice(0, 80)}`);
  process.exit(0);
});
socket.on("error", (error) =>
  console.log(`[${mode}] error at ${stamp()}: ${String(error).slice(0, 100)}`),
);
/* A hard ceiling so unattended runs end: an hour of survival is the answer
 * "it lives for hours" for tonight's purposes. */
setTimeout(() => {
  console.log(`[${mode}] SURVIVED 3600s; closing ourselves`);
  process.exit(0);
}, 3_600_000);
/* A local heartbeat so a tail shows the run is alive; touches no network. */
setInterval(() => console.log(`[${mode}] still open at ${stamp()}`), 300_000);

if (mode === "silent" || mode === "ping") {
  socket.on("open", () => {
    console.log(`[${mode}] open after ${stamp()}`);
    if (mode === "ping") {
      const timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 15_000);
      socket.once("close", () => clearInterval(timer));
    }
  });
  socket.on("pong", () => console.log(`[${mode}] pong at ${stamp()}`));
  socket.on("message", (data) =>
    console.log(`[${mode}] message at ${stamp()}: ${String(data).slice(0, 80)}`),
  );
} else if (mode === "mount") {
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  console.log(`[${mode}] open after ${stamp()}`);
  const session = newWebSocketRpcSession(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required");
  const root = (session as unknown as { authenticate(auth: unknown): unknown }).authenticate({
    type: "admin-secret",
    secret,
  }) as { projects: { connect(idOrSlug: string, opts: unknown): Promise<unknown> } };
  const clientPath = `/clients/lifetime-${startedAt.toString(36)}`;
  await root.projects.connect(process.env.ITERATE_PROJECT ?? "voice-test", {
    path: clientPath,
    description: "socket-lifetime mount-invariant instrument",
    capabilities: {
      ping: () => `alive at ${stamp()}`,
    },
  });
  console.log(
    `[${mode}] connected as ${clientPath} with a live capability at ${stamp()}; going silent`,
  );
  console.log(
    `[${mode}] to prove the invariant: kill that scope's stream and watch for close 4901`,
  );
} else if (mode === "rpc" || mode === "open") {
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  console.log(`[${mode}] open after ${stamp()}`);
  const session = newWebSocketRpcSession(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required");
  // Same call chain as connectItxReady({auth: {type: "admin-secret"}}), inlined
  // so the raw socket above stays observable.
  const root = (session as unknown as { authenticate(auth: unknown): unknown }).authenticate({
    type: "admin-secret",
    secret,
  }) as {
    projects: {
      get(id: string): { projectId: Promise<string>; streams: { get(path: string): StreamHandle } };
    };
  };
  const project = root.projects.get(process.env.ITERATE_PROJECT ?? "voice-test");
  const projectId = await project.projectId;
  console.log(`[${mode}] RPC ok at ${stamp()} (${String(projectId).slice(0, 12)})`);

  if (mode === "open") {
    /* The soak's connection leg, minus the voice agent: a fresh stream so no
     * processor wakes, a retained deliver callback, one durable event echoed
     * back to prove the leg is live — then nothing, forever. */
    const streamPath = `voicelab/lifetime-${startedAt.toString(36)}`;
    const stream = project.streams.get(streamPath);
    await stream.openConnection({
      connectionKey: `lifetime-${startedAt}`,
      eventTypes: ["events.iterate.com/voicelab/lifetime-marker"],
      processEventBatch: (batch: { events?: { type: string }[] }) => {
        console.log(`[${mode}] delivered ${batch.events?.length ?? 0} event(s) at ${stamp()}`);
      },
    });
    await stream.append({
      type: "events.iterate.com/voicelab/lifetime-marker",
      payload: { openedAt: startedAt },
    });
    console.log(
      `[${mode}] connection open on ${streamPath}, marker appended at ${stamp()}; going silent`,
    );
  } else {
    console.log(`[${mode}] going silent`);
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}

interface StreamHandle {
  openConnection(options: {
    connectionKey: string;
    eventTypes: string[];
    processEventBatch: (batch: { events?: { type: string }[] }) => void;
  }): Promise<unknown>;
  append(event: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
}
