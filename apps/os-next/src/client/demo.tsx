// client/demo.tsx — THE HOSTED DEMO. build-sdk.mjs bundles this (React + react-dom + the capnweb
// fork + the useLiveState hook, all inlined — no CDN) into one self-contained HTML string the worker
// serves at `/demo` (worker.ts). Open it against any deployment: it dials `/api` over capnweb exactly
// like production, loads the `PresenceProcessor` into a dynamic worker, subscribes to its live state,
// and renders reduced ⊕ runtime — the `ticks` reduce and the `lastPokeMs` runtime field — updating live
// as you press the buttons, each of which just appends an event on the stream.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { z } from "zod";
import { PRESENCE_PROCESSOR_SOURCE } from "../generated/presence-processor-source.ts";
import type { IterateContextRpcTarget, IterateRpcTarget } from "../types.ts";
import { useLiveState } from "./react.tsx";

/** Dial /api with the console's login cookie (it rode the handshake; the visitor signed in at `/`)
 *  and open the visitor's own demo project — `demo-<email>`, created in their org on first visit.
 *  Over the wire an `IterateContextRpcTarget` arrives as a capnweb `RpcStub<…>` (the pass-by-reference
 *  proxy of its public methods), which is what `newWebSocketRpcSession<T>` and an awaited call yield. */
async function connectAndEnable(): Promise<RpcStub<IterateContextRpcTarget>> {
  const url = new URL("/api", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // The public root is the IterateRpcTarget; capnweb pipelines, so the returned session is usable at once.
  const session = newWebSocketRpcSession<IterateRpcTarget>(url.toString()).authenticate({
    type: "from-server-cookie",
  });
  const { email } = await session.whoami();
  const itx = await session.projects.create({ project: `demo-${email}` });
  await itx.processors.enable("presence", {
    source: PRESENCE_PROCESSOR_SOURCE, // the modules, literally — nothing seeded anywhere first
    className: "PresenceDurableObject",
    // What is SENT: the contract above says what is reduced. `poke` is ephemeral, and an
    // ephemeral reaches a processor only when its subscription names the type.
    consumes: ["tick", "poke"],
  });
  return itx;
}

// oxlint-disable-next-line react/only-export-components -- entry-point bundle: Demo is rendered below, never imported, so fast refresh doesn't apply
function Demo() {
  const [itx, setItx] = useState<RpcStub<IterateContextRpcTarget>>();
  const [connectError, setConnectError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    connectAndEnable().then(
      // A capnweb stub is a callable Proxy (`typeof === "function"`), so `setItx(scope)` would make
      // React treat it as a state-updater and call `scope(prev)` — an empty-path call on the
      // non-callable `IterateContextRpcTarget`, which throws `'' is not a function`. Store it via a functional update.
      (scope) => !disposed && setItx(() => scope),
      (e: unknown) => !disposed && setConnectError(e instanceof Error ? e.message : String(e)),
    );
    return () => void (disposed = true);
  }, []);

  const { value, rev, status, error } = useLiveState<{ ticks: number; lastPokeMs: number }>(itx, {
    key: "presence",
    door: async () => {
      if (!itx) throw new Error("no connection"); // useLiveState calls the door only once itx is set
      return z
        .object({ rev: z.number(), state: z.object({ ticks: z.number(), lastPokeMs: z.number() }) })
        .parse(await itx.invoke("itx.facets.get('presence').liveSnapshot()"));
    },
  });

  // A failed append (a dropped socket, a paused stream) must surface on the page, not vanish as an
  // unhandled rejection while the status still says "live".
  const showAppendError = (e: unknown) =>
    setConnectError(`append failed: ${e instanceof Error ? e.message : String(e)}`);

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
          {connectError ? `connect error: ${connectError}` : error || status}
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
        <button
          type="button"
          disabled={!itx}
          onClick={() => void Promise.resolve(itx?.append({ type: "tick" })).catch(showAppendError)}
          style={btn}
        >
          append tick (reduced +1)
        </button>
        <button
          type="button"
          disabled={!itx}
          onClick={() =>
            void Promise.resolve(itx?.append({ type: "poke", ephemeral: true })).catch(
              showAppendError,
            )
          }
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
