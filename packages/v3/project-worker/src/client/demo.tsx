// client/demo.tsx — THE HOSTED DEMO. build-sdk.mjs bundles this (React + react-dom + the capnweb
// fork + the useLiveState hook, all inlined — no CDN) into one self-contained HTML string the worker
// serves at `/demo` (worker.ts). Open it against any deployment: it dials `/api` over capnweb exactly
// like production, loads the `PresenceProcessor` into a dynamic worker, subscribes to its live state,
// and renders reduced ⊕ runtime — the `ticks` reduce and the `lastPokeMs` runtime field — updating live
// as you press the buttons, each of which just appends an event on the stream.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession } from "capnweb";
import { useLiveState } from "./react.tsx";

const CTX = "prj_demo_livestate";

// The demo processor, inline (a self-contained page needs no repo files): reduced `ticks` reduced
// from durable 'tick' events, runtime `lastPokeMs` bumped by a 'poke' ephemeral in processEvent (the
// engine re-projects after the batch). Two classes: the pure `PresenceProcessor`, and the one-line host
// `PresenceDurableObject` that `enableProcessor`'s `className` names.
const PRESENCE_SRC = `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "presence", version: "1.0.0",
  description: "Reduced tick count beside a runtime lastPokeMs.",
  stateSchema: z.object({ ticks: z.number().default(0) }), events: {},
  consumes: ["tick", "poke"], emits: [],
});
class PresenceProcessor extends StreamProcessor {
  contract = contract;
  #lastPokeMs = 0;
  reduce({ event, state }) { if (event.type === "tick") return { ...state, ticks: state.ticks + 1 }; }
  processEvent({ event }) { if (event && event.type === "poke") this.#lastPokeMs = Date.now(); }
  projectLiveState(state) { return { ticks: state.ticks, lastPokeMs: this.#lastPokeMs }; }
}
export class PresenceDurableObject extends StreamProcessorDurableObject {
  processor = new PresenceProcessor();
}`;

async function connectAndEnable(): Promise<any> {
  const url = new URL("/api", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const itx = await (newWebSocketRpcSession(url.toString()) as any)
    .authenticate()
    .projects.get(CTX);
  await itx.invoke(["itx", "kv", ["put", "src/presence.js", PRESENCE_SRC]]);
  await itx.enableProcessor("presence", {
    source: "itx.kv.get('src/presence.js')",
    className: "PresenceDurableObject",
    // What is SENT: the contract above says what is reduced. `poke` is ephemeral, and an
    // ephemeral reaches a processor only when its subscription names the type.
    consumes: ["tick", "poke"],
  });
  return itx;
}

// oxlint-disable-next-line react/only-export-components -- entry-point bundle: Demo is rendered below, never imported, so fast refresh doesn't apply
function Demo() {
  const [itx, setItx] = useState<any>();
  const [connectError, setConnectError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    connectAndEnable().then(
      // A capnweb stub is a callable Proxy (`typeof === "function"`), so `setItx(scope)` would make
      // React treat it as a state-updater and call `scope(prev)` — an empty-path call on the
      // non-callable `IterateContext`, which throws `'' is not a function`. Store it via a functional update.
      (scope) => !disposed && setItx(() => scope),
      (e: unknown) => !disposed && setConnectError(e instanceof Error ? e.message : String(e)),
    );
    return () => void (disposed = true);
  }, []);

  const { value, rev, status, error } = useLiveState<{ ticks: number; lastPokeMs: number }>(itx, {
    key: "presence",
    door: () => itx.invoke("itx.facets.get('presence').liveSnapshot()"),
  });

  // A failed append (a dropped socket, a paused stream) must surface on the page, not vanish as an
  // unhandled rejection while the status still says "live".
  const append = (event: Record<string, unknown>) =>
    void itx?.invoke(["itx", ["append", event]]).catch((e: unknown) => {
      setConnectError(`append failed: ${e instanceof Error ? e.message : String(e)}`);
    });

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
