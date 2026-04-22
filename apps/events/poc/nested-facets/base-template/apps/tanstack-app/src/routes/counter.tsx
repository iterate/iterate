import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

// Server function that could use DO storage in a real integration
const getCount = createServerFn({ method: "GET" }).handler(async () => {
  // In a real DO integration, this would read from this.ctx.storage
  return { count: 0 };
});

export const Route = createFileRoute("/counter")({
  loader: async () => {
    return getCount();
  },
  component: Counter,
});

function Counter() {
  const initialData = Route.useLoaderData();
  const [count, setCount] = useState(initialData.count);

  return (
    <main>
      <h1>Counter</h1>
      <p>Client-side interactivity working alongside SSR.</p>
      <div className="counter">{count}</div>
      <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
        <button onClick={() => setCount((c) => c - 1)}>- Decrement</button>
        <button onClick={() => setCount((c) => c + 1)}>+ Increment</button>
      </div>
      <p style={{ marginTop: "1rem", fontSize: "0.85rem", textAlign: "center" }}>
        Initial value loaded via server function during SSR, then hydrated for client interactivity.
      </p>
    </main>
  );
}
