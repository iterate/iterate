import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { normalizeListSlug } from "../state.ts";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const navigate = useNavigate();
  const [slug, setSlug] = useState("");
  const go = (target: string) => {
    const normalized = normalizeListSlug(target);
    if (normalized) void navigate({ to: "/l/$slug", params: { slug: normalized } });
  };
  return (
    <main>
      <h1>Todos</h1>
      <p>Every list is a Durable Object; everyone on the same URL edits it live.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          go(slug);
        }}
      >
        <input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="list name"
          aria-label="list name"
        />
        <button type="submit">open</button>
      </form>
      <p>
        <button type="button" onClick={() => go(`list-${crypto.randomUUID().slice(0, 8)}`)}>
          new random list
        </button>
      </p>
    </main>
  );
}
