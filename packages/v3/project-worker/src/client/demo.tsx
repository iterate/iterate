// client/demo.tsx — THE HOSTED DEMO. build-sdk.mjs bundles this (React + react-dom + the capnweb
// fork + the useLiveState hook, all inlined — no CDN) into one self-contained HTML string the worker
// serves at `/demo` (worker.ts). Open it against any deployment: it dials `/api` over capnweb exactly
// like production, loads the Presence processor into a dynamic worker, subscribes to its live state,
// and renders reduced ⊕ runtime — the `ticks` fold and the `lastPokeMs` runtime field — updating live
// as you press the buttons, each of which just appends an event on the stream.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession } from "capnweb";
import { useLiveState } from "./react.tsx";

const CTX = "prj_demo_livestate";
type PresenceLive = { ticks: number; lastPokeMs: number };

// The demo processor, inline (a self-contained page needs no repo files): reduced `ticks` folded
// from durable 'tick' events, runtime `lastPokeMs` bumped by a 'poke' ephemeral in processEvent.
const PRESENCE_SRC = `import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "presence", version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs.",
  stateSchema: z.object({ ticks: z.number().default(0) }), events: {},
  consumes: ["tick", "poke"], emits: [],
});
export class Presence extends StreamProcessor {
  contract = contract;
  #lastPokeMs = 0;
  reduce({ event, state }) { if (event.type === "tick") return { ...state, ticks: state.ticks + 1 }; }
  processEvent({ event }) { if (event && event.type === "poke") { this.#lastPokeMs = Date.now(); this.publishLiveState(); } }
  liveState(state) { return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs }; }
}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function connectAndEnable(): Promise<any> {
  const url = new URL("/api", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ctx", CTX);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itx = await (newWebSocketRpcSession(url.toString()) as any).authenticate().get();
  await itx.invokeCapability(["itx", "kv", ["put", "src/presence.js", PRESENCE_SRC]]);
  await itx.enableProcessor("presence", {
    source: "itx.kv.get('src/presence.js')",
    className: "Presence",
  });
  return itx;
}

function Demo() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [itx, setItx] = useState<any>();
  const [connectError, setConnectError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    connectAndEnable().then(
      (scope) => !disposed && setItx(scope),
      (e: unknown) => !disposed && setConnectError(e instanceof Error ? e.message : String(e)),
    );
    return () => void (disposed = true);
  }, []);

  const { value, rev, status, error } = useLiveState<PresenceLive>(itx, {
    key: "presence",
    door: () => itx.invokeCapability("itx.facets.get('presence').liveSnapshot()"),
  });

  const append = (event: Record<string, unknown>) =>
    void itx?.invokeCapability(["itx", "stream", ["append", event]]);

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: "34rem",
        margin: "3rem auto",
        padding: "0 1.25rem",
        lineHeight: 1.55,
      }}
    >
      <h1 style={{ fontSize: "1.15rem", fontWeight: 600, letterSpacing: "0.02em" }}>
        clean-room live state — reduced ⊕ runtime
      </h1>
      <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>
        A dynamic-worker processor. <code>ticks</code> is reduced from durable events;{" "}
        <code>lastPokeMs</code> is a runtime field the reduce never touches. Both stream to this
        page as ephemeral live-state deltas over one revision chain.
      </p>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "0.35rem 1.25rem",
          margin: "1.75rem 0",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{ color: "#6b7280" }}>status</span>
        <span data-testid="status">
          {connectError ? `connect error: ${connectError}` : (error ?? status)}
        </span>
        <span style={{ color: "#6b7280" }}>rev</span>
        <span data-testid="rev">{rev ?? "—"}</span>
        <span style={{ color: "#6b7280" }}>ticks (reduced)</span>
        <span data-testid="ticks" style={{ fontSize: "1.4rem" }}>
          {value ? value.ticks : "—"}
        </span>
        <span style={{ color: "#6b7280" }}>lastPokeMs (runtime)</span>
        <span data-testid="lastPokeMs" style={{ fontSize: "1.4rem" }}>
          {value ? value.lastPokeMs : "—"}
        </span>
      </section>

      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button type="button" disabled={!itx} onClick={() => append({ type: "tick" })} style={btn}>
          append tick (reduced +1)
        </button>
        <button
          type="button"
          disabled={!itx}
          onClick={() => append({ type: "poke", ephemeral: true })}
          style={btn}
        >
          poke (runtime)
        </button>
      </div>
    </main>
  );
}

const btn: React.CSSProperties = {
  font: "inherit",
  padding: "0.5rem 0.9rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  background: "#fff",
  cursor: "pointer",
};

const el = document.getElementById("root");
if (el) createRoot(el).render(<Demo />);
