import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useGuestbook } from "../lib/use-guestbook.ts";

export const Route = createFileRoute("/")({ component: Guestbook });

// The project's public guestbook. Its state is a stream-processor fold on the
// project stream at /guestbook (src/worker.ts hosts the processor); this page
// hydrates, opens /api, and stays live — every open tab repaints the moment
// anyone signs, and every fifth signature earns a milestone from the
// processor's at-head reconcile.
function Guestbook() {
  const { guestbook, api, error } = useGuestbook();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const ready = api !== null && guestbook !== undefined;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {guestbook?.birthCertificate?.config.title ?? "Guestbook"}
        </h1>
        {guestbook !== undefined ? (
          <p className="text-sm text-stone-500">
            {guestbook.entries.length === 0
              ? "no signatures yet"
              : `${guestbook.entries.length} signature${guestbook.entries.length === 1 ? "" : "s"}`}
            {guestbook.lastMilestone > 0 ? (
              <span className="ml-2 inline-flex items-baseline gap-1.5">
                <span className="inline-block size-1.5 translate-y-px rounded-full bg-amber-400" />
                milestone {guestbook.lastMilestone}
              </span>
            ) : null}
          </p>
        ) : null}
      </header>

      {error !== null ? (
        <p className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <form
        className="mt-8 space-y-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (api && name.trim() && message.trim()) {
            void api.sign(name, message);
            setMessage("");
          }
        }}
      >
        <div className="flex gap-3">
          <input
            className="w-40 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm outline-none transition focus:border-amber-400 focus:bg-white focus:ring-2 focus:ring-amber-100"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="name"
            aria-label="your name"
            disabled={!ready}
          />
          <input
            className="flex-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm outline-none transition focus:border-amber-400 focus:bg-white focus:ring-2 focus:ring-amber-100"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="leave a message"
            aria-label="your message"
            disabled={!ready}
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-stone-400" aria-live="polite">
            {ready ? "signatures appear live in every open tab" : "connecting…"}
          </p>
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!ready || name.trim() === "" || message.trim() === ""}
          >
            Sign
          </button>
        </div>
      </form>

      <section className="mt-8 space-y-3" aria-label="signatures">
        {guestbook === undefined ? (
          <p className="text-sm text-stone-400">loading signatures…</p>
        ) : guestbook.entries.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-400">
            Nobody has signed yet — be the first.
          </p>
        ) : (
          guestbook.entries
            .map((entry, index) => ({ entry, index }))
            .reverse()
            // The pre-reverse index: entries are append-only in the fold, so
            // it identifies a row for its whole lifetime — a new signature
            // inserts one element instead of remounting the list.
            .map(({ entry, index }) => (
              <article
                key={index}
                className="flex gap-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-800"
                >
                  {entry.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{entry.name}</span>
                    <time
                      className="shrink-0 text-xs text-stone-400"
                      dateTime={entry.signedAt}
                      title={entry.signedAt}
                    >
                      {new Date(entry.signedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </p>
                  <p className="mt-0.5 break-words text-sm text-stone-600">{entry.message}</p>
                </div>
              </article>
            ))
        )}
      </section>
    </main>
  );
}
