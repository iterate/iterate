/**
 * Public guestbook UI. Live reduced state over Cap'n Web + shared
 * useLiveStateRpc (see apps/use-live-state-rpc.ts / packages/iterate).
 */
import React, { type FormEvent, useEffect, useState } from "https://esm.sh/react@19.2.4";
import { createRoot } from "https://esm.sh/react-dom@19.2.4/client";
import { newWebSocketRpcSession } from "https://esm.sh/@iterate-com/capnweb@0.10.0";
import { useLiveStateRpc, type LiveStateRpc } from "../use-live-state-rpc.ts";

type GuestbookState = {
  birthCertificate: { config: { title: string } } | null;
  entries: Array<{ name: string; message: string; signedAt: string }>;
  lastMilestone: number;
};

type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookState>;
  sign(name: string, message: string): Promise<void>;
};

function useGuestbookApi() {
  const [api, setApi] = useState<GuestbookApi | null>(null);

  useEffect(() => {
    // Updater form is load-bearing: Cap'n Web stubs are callable Proxies, so
    // setApi(stub) would make React CALL the stub as an updater.
    setApi(() => null);
    const endpoint = new URL("/api", window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const publicApi = newWebSocketRpcSession<GuestbookApi>(endpoint.toString());
    setApi(() => publicApi);
    return () => {
      publicApi[Symbol.dispose]();
      setApi(() => null);
    };
  }, []);

  return api;
}

export function GuestbookClient() {
  const api = useGuestbookApi();
  const { value: state, error: liveError } = useLiveStateRpc(
    api,
    (session) => session.liveState,
    (s) => s,
  );
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");

  const error = liveError ?? (signError.length > 0 ? signError : undefined);
  const entries = state?.entries ?? [];
  // Only claim the configured title once reduced state has arrived — the
  // seeded-apps heading wait must not pass on the HTML shell alone.
  const title =
    state === undefined ? "Loading…" : (state.birthCertificate?.config.title ?? "Guestbook");

  const sign = async (event: FormEvent) => {
    event.preventDefault();
    if (api == null) return;
    setSigning(true);
    setSignError("");
    try {
      await api.sign(name, message);
      setMessage("");
    } catch (cause) {
      setSignError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSigning(false);
    }
  };

  return (
    <>
      <h1>{title}</h1>
      <form onSubmit={sign}>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          maxLength={80}
          onChange={(event) => setName(event.currentTarget.value)}
          required
          value={name}
        />
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          maxLength={500}
          onChange={(event) => setMessage(event.currentTarget.value)}
          required
          rows={4}
          value={message}
        />
        <button disabled={api == null || signing} type="submit">
          Sign guestbook
        </button>
      </form>
      {error !== undefined && <p role="alert">{error}</p>}
      {state === undefined ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No entries yet.</p>
      ) : (
        <section aria-label="Guestbook entries">
          {/* Newest first; key on payload identity (not reversed index). */}
          {[...entries].reverse().map((entry) => (
            <article key={`${entry.signedAt}\0${entry.name}\0${entry.message}`}>
              <strong>{entry.name}</strong> <time dateTime={entry.signedAt}>{entry.signedAt}</time>
              <p>{entry.message}</p>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<GuestbookClient />);
