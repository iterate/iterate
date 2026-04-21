/**
 * Manual probe: open IterateAgent WebSocket, send one codemode-block-added that
 * fetches https://example.com/, print all frames until codemode-result or timeout.
 *
 * Usage (from apps/agents, with dev server up):
 *   npx tsx scripts/poke-iterate-ws.mts http://127.0.0.1:52347
 */
const baseArg = process.argv[2]?.replace(/\/+$/, "") ?? "http://127.0.0.1:5173";
const wsUrl = new URL(baseArg);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/agents/iterate-agent/poke-manual";

const script = `
async () => {
  const r = await fetch("https://example.com/");
  const body = await r.text();
  return { status: r.status, head: body.slice(0, 80) };
}
`.trim();

const deadlineMs = 45_000;
const t0 = Date.now();

const ws = new WebSocket(wsUrl.toString());

ws.addEventListener("open", () => {
  console.error(`[poke] open ${wsUrl.toString()} (+${Date.now() - t0}ms)`);
  // Let OpenAPI spec preload (onStart) finish so execute() is not blocked on first line.
  setTimeout(() => {
    // IterateAgent.onMessage validates inbound frames against
    // StreamSocketEventFrame, which requires the full `Event` shape
    // (`streamPath`, `offset`, `createdAt`). Anything short is silently
    // dropped as `not-stream-socket-frame`. Fill in dev-only stubs so the
    // frame parses and the processor actually runs.
    ws.send(
      JSON.stringify({
        type: "event",
        event: {
          type: "codemode-block-added",
          payload: { script },
          streamPath: "/agents/poke-iterate-ws",
          offset: Date.now(),
          createdAt: new Date().toISOString(),
        },
      }),
    );
  }, 2_500);
});

ws.addEventListener("message", (ev) => {
  const text = String(ev.data);
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  console.error(`[poke] message +${Date.now() - t0}ms len=${text.length}`);
  console.log(preview);
  try {
    const parsed = JSON.parse(text) as { type?: string; event?: { type?: string } };
    if (parsed.type === "append" && parsed.event?.type === "codemode-result-added") {
      console.error(`[poke] got codemode-result (+${Date.now() - t0}ms) — ok`);
      ws.close();
      process.exit(0);
    }
  } catch {
    // ignore
  }
});

ws.addEventListener("error", (e) => {
  console.error("[poke] websocket error", e);
  process.exit(1);
});

setTimeout(() => {
  console.error(`[poke] TIMEOUT after ${deadlineMs}ms`);
  try {
    ws.close();
  } catch {
    /* ignore close errors */
  }
  process.exit(2);
}, deadlineMs);
