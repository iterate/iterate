import { useState } from "react";
import { useGuestbook } from "./lib/use-guestbook.ts";

// The project's public guestbook. Its state is a stream-processor fold on the
// project stream at /guestbook (src/guestbook-app.ts hosts the processor);
// this page hydrates, opens /api, and stays live — every open tab repaints the
// moment anyone signs, and every fifth signature earns a milestone from the
// processor's at-head reconcile.
export function Guestbook() {
  const { guestbook, api, error } = useGuestbook();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const ready = api !== null && guestbook !== undefined;

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>{guestbook?.birthCertificate?.config.title ?? "Guestbook"}</h1>
        {guestbook !== undefined ? (
          <p style={styles.meta}>
            {guestbook.entries.length === 0
              ? "no signatures yet"
              : `${guestbook.entries.length} signature${guestbook.entries.length === 1 ? "" : "s"}`}
            {guestbook.lastMilestone > 0 ? (
              <span style={styles.milestone}> · milestone {guestbook.lastMilestone}</span>
            ) : null}
          </p>
        ) : null}
      </header>

      {error !== null ? <p style={styles.error}>{error}</p> : null}

      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (api && name.trim() && message.trim()) {
            void api.sign(name, message);
            setMessage("");
          }
        }}
      >
        <div style={styles.row}>
          <input
            style={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="name"
            aria-label="your name"
            disabled={!ready}
          />
          <input
            style={{ ...styles.input, flex: 1 }}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="leave a message"
            aria-label="your message"
            disabled={!ready}
          />
        </div>
        <div style={styles.rowBetween}>
          <p style={styles.hint} aria-live="polite">
            {ready ? "signatures appear live in every open tab" : "connecting…"}
          </p>
          <button
            type="submit"
            style={styles.button}
            disabled={!ready || name.trim() === "" || message.trim() === ""}
          >
            Sign
          </button>
        </div>
      </form>

      <section style={styles.section} aria-label="signatures">
        {guestbook === undefined ? (
          <p style={styles.hint}>loading signatures…</p>
        ) : guestbook.entries.length === 0 ? (
          <p style={styles.empty}>Nobody has signed yet — be the first.</p>
        ) : (
          guestbook.entries
            .map((entry, index) => ({ entry, index }))
            .reverse()
            .map(({ entry, index }) => (
              <article key={index} style={styles.card}>
                <span aria-hidden style={styles.avatar}>
                  {entry.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <p style={styles.cardTitle}>
                    <span>{entry.name}</span>
                    <time dateTime={entry.signedAt} title={entry.signedAt} style={styles.time}>
                      {new Date(entry.signedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </p>
                  <p style={styles.message}>{entry.message}</p>
                </div>
              </article>
            ))
        )}
      </section>
    </main>
  );
}

const styles = {
  main: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 560,
    margin: "0 auto",
    padding: "48px 16px",
  },
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 },
  h1: { fontSize: 28, margin: 0 },
  meta: { fontSize: 14, color: "#78716c", margin: 0 },
  milestone: { color: "#b45309" },
  error: {
    marginTop: 24,
    padding: "12px 16px",
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#b91c1c",
    borderRadius: 8,
    fontSize: 14,
  },
  form: {
    marginTop: 32,
    padding: 16,
    border: "1px solid #e7e5e4",
    borderRadius: 16,
    background: "#fff",
  },
  row: { display: "flex", gap: 12 },
  rowBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  input: {
    width: 160,
    border: "1px solid #e7e5e4",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 14,
  },
  button: {
    border: 0,
    borderRadius: 8,
    padding: "8px 16px",
    background: "#1c1917",
    color: "#fff",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  hint: { fontSize: 12, color: "#a8a29e", margin: 0 },
  section: { marginTop: 32, display: "flex", flexDirection: "column" as const, gap: 12 },
  empty: {
    border: "1px dashed #d6d3d1",
    borderRadius: 16,
    padding: "32px 16px",
    textAlign: "center" as const,
    color: "#a8a29e",
    fontSize: 14,
  },
  card: {
    display: "flex",
    gap: 12,
    border: "1px solid #e7e5e4",
    borderRadius: 16,
    padding: 16,
    background: "#fff",
  },
  avatar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    borderRadius: "999px",
    background: "#fef3c7",
    color: "#92400e",
    fontWeight: 600,
    fontSize: 14,
    flexShrink: 0,
  },
  cardTitle: { display: "flex", alignItems: "baseline", gap: 8, margin: 0, fontWeight: 500 },
  time: { fontSize: 12, color: "#a8a29e", fontWeight: 400 },
  message: { margin: "4px 0 0", fontSize: 14, color: "#57534e" },
} as const;
