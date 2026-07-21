import React, { type FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Entry = {
  id: string;
  message: string;
  name: string;
  signedAt: string;
};

async function api<T>(init?: RequestInit): Promise<T> {
  const response = await fetch("/api/entries", init);
  if (!response.ok)
    throw new Error((await response.text()) || `request failed (${response.status})`);
  return (await response.json()) as T;
}

export function GuestbookClient() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    try {
      setEntries(await api<Entry[]>());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sign = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api<Entry>({
        body: JSON.stringify({ message, name }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setMessage("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <h1>Guestbook</h1>
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
        <button type="submit">Sign guestbook</button>
      </form>
      {error.length > 0 && <p role="alert">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No entries yet.</p>
      ) : (
        <section aria-label="Guestbook entries">
          {entries.map((entry) => (
            <article key={entry.id}>
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
