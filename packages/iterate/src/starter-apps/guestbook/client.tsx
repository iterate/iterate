/**
 * Public guestbook UI. The provider owns the reconnectable Cap'n Web root;
 * useLiveState consumes the nearest root.
 * @jsxImportSource react
 */
import React, { useActionState } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession, type RpcStub } from "../../sdk/capnweb/index.ts";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "../../sdk/capnweb/react.tsx";
import type { GuestbookApi } from "./worker.ts";

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
  const [signError, sign, signing] = useActionState(async (_: string, form: FormData) => {
    if (api == null) return "Guestbook connection is not ready";
    try {
      await api.sign(String(form.get("name") || ""), String(form.get("message") || ""));
      return "";
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }, "");

  const error = liveError || (signError.length > 0 ? signError : undefined);
  const entries = state?.entries || [];
  // Only claim the configured title once reduced state has arrived — the
  // seeded-apps heading wait must not pass on the HTML shell alone.
  const title =
    state === undefined ? "Loading…" : state.birthCertificate?.config.title || "Guestbook";

  return (
    <>
      <h1>{title}</h1>
      <form action={sign}>
        <label htmlFor="name">Name</label>
        <input id="name" maxLength={80} name="name" required />
        <label htmlFor="message">Message</label>
        <textarea id="message" maxLength={500} name="message" required rows={4} />
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
