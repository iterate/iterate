// client/demo.tsx — THE HOSTED DEMO. build-sdk.mjs bundles this (React + react-dom + the capnweb
// fork + the useLiveState hook, all inlined — no CDN) into one self-contained HTML string the worker
// serves at `/demo` (worker.ts). Open it against any deployment: it dials `/api` over capnweb exactly
// like production, loads the `PresenceProcessor` into a dynamic worker, subscribes to its live state,
// and renders reduced ⊕ runtime — the `ticks` reduce and the `lastPokeMs` runtime field — updating live
// as you press the buttons, each of which just appends an event on the stream.

import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession } from "capnweb";
import { PRESENCE_PROCESSOR_SOURCE } from "./presence-processor-source.ts";
import {
  connectLiveState,
  type LiveStateItx,
  type LiveStateSeed,
  type LiveStateStore,
} from "./live-state.ts";

// ── react ── the REACT binding for clean-room live state. `useLiveState` subscribes a
// component to a producer's live state (a processor slug, a mini-app key), seeds through its door,
// and re-renders on every synced delta via `useSyncExternalStore` over the LiveStateStore. It is the
// browser half of the door+delta loop; the transport and the store// (client/live-state.ts) stay framework-free, so only this file imports React.
//
// Adapted from apps/os's `useLiveState` (packages/iterate/src/sdk/capnweb/react.tsx), kept to the
// one shape a demo/test needs — no reconnect/backoff/ping-watchdog (that policy belongs to whoever
// owns the capnweb session; here the caller passes a ready `itx`).

export type LiveStateStatus = "connecting" | "live" | "error";

/** Subscribe to a producer's live state and render its latest value. Pass a ready `itx` (a capnweb
 *  `api.authenticate(credentials).projects.get(id)`), the producer's `key`, and a `door` thunk that reads `{rev, state}`
 *  (`() => itx.invoke("itx.facets.get('slug').liveSnapshot()")`). Re-subscribes when the
 *  session, `key`, or `name` changes; unmount (and every re-subscribe) disposes the previous
 *  server-side subscription. */
export function useLiveState<S>(
  itx: LiveStateItx | undefined,
  opts: { key: string; name?: string; door: () => Promise<LiveStateSeed<S>> },
): { value: S | undefined; rev: number | null; status: LiveStateStatus; error?: string } {
  const [store, setStore] = useState<LiveStateStore<S> | undefined>();
  const [status, setStatus] = useState<LiveStateStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  // The door thunk is a fresh arrow every render; hold the latest so the effect need not re-run per
  // render. The effect SNAPSHOTS it at connect time, so an old subscription's gap heal can never
  // read a NEWER key's door (cross-key contamination after a key/session switch).
  const doorRef = useRef(opts.door);
  doorRef.current = opts.door;

  useEffect(() => {
    setStore(undefined);
    setStatus("connecting");
    setError(undefined);
    if (!itx) return;
    const door = doorRef.current; // pinned to THIS key/session for the connection's whole life
    let disposed = false;
    let dispose: (() => Promise<void>) | undefined;
    const unmounted = new AbortController(); // an unmount while the first seed is pending recalls the row
    connectLiveState<S>(itx, {
      key: opts.key,
      name: opts.name,
      door,
      signal: unmounted.signal,
      onResync: (r) => {
        if (disposed) return;
        if (r === "healed") {
          setStatus("live");
          setError(undefined);
        } else {
          // the store keeps its last value; the next delta retries the heal
          setStatus("error");
          setError(r.message);
        }
      },
    }).then(
      (conn) => {
        dispose = conn.dispose;
        if (disposed) {
          void conn.dispose(); // unmounted while connecting — still tear the mount down
          return;
        }
        setStore(conn.store);
        setStatus("live");
      },
      (e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      },
    );
    return () => {
      disposed = true;
      unmounted.abort();
      void dispose?.();
    };
  }, [itx, opts.key, opts.name]);

  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
    [store],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => store?.get(),
    () => undefined,
  );
  return { value, rev: store?.rev() ?? null, status, error };
}

/** Dial /api with the console's login cookie (it rode the handshake; the visitor signed in at `/`)
 *  and open the visitor's own demo project — `demo-<email>`, created in their org on first visit. */
async function connectAndEnable(): Promise<any> {
  const url = new URL("/api", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const session = (newWebSocketRpcSession(url.toString()) as any).authenticate({
    type: "from-server-cookie",
  });
  const { email } = await session.whoami();
  const itx = await session.projects.create({ project: `demo-${email}` });
  await itx.enableProcessor("presence", {
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
