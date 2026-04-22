import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main>
      <h1>About</h1>
      <p>
        This POC demonstrates that a full TanStack Start application can run inside a Cloudflare
        Durable Object "facet" — a dynamically-loaded worker instance cached by source hash.
      </p>
      <h2 style={{ fontSize: "1.1rem", marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        How it works
      </h2>
      <ul style={{ paddingLeft: "1.5rem", color: "#aaa", lineHeight: 2 }}>
        <li>TanStack Start is built with Vite, producing server + client bundles</li>
        <li>The server bundle exports a WinterCG-compatible fetch handler</li>
        <li>A thin wrapper puts it in a DurableObject class</li>
        <li>The Project DO loads it via LOADER as a dynamic worker facet</li>
        <li>Client assets are served from the Project DO's workspace</li>
        <li>SSR, streaming, and server functions all work inside the DO</li>
      </ul>
    </main>
  );
}
