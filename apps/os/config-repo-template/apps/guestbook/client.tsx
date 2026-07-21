/**
 * Public guestbook UI. The provider owns the reconnectable Cap'n Web root;
 * useLiveState consumes the nearest root.
 */
import { newWebSocketRpcSession, type RpcStub } from "@iterate-com/capnweb";
import React, { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LiveStateRpc } from "iterate/live-state";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "iterate/live-state/react";

type GuestbookState = {
  birthCertificate: { config: { title: string } } | null;
  entries: Array<{ name: string; message: string; signedAt: string }>;
};

type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookState>;
  sign(name: string, message: string): Promise<void>;
};

function makeConnection() {
  const endpoint = new URL("/api", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<GuestbookApi>(endpoint.toString());
}

export function GuestbookClient() {
  const api = useCapnWebRoot<RpcStub<GuestbookApi>>();
  const { value: state, error: liveError } = useLiveState(
    (session: RpcStub<GuestbookApi>) => session.liveState,
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
createRoot(root).render(
  <CapnWebProvider makeConnection={makeConnection}>
    <GuestbookClient />
  </CapnWebProvider>,
);
