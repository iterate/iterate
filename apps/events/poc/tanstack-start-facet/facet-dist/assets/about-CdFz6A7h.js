import { m as e } from "./index-CGt5-eaW.js";
function i() {
  return e.jsxs("main", {
    children: [
      e.jsx("h1", { children: "About" }),
      e.jsx("p", {
        children:
          'This POC demonstrates that a full TanStack Start application can run inside a Cloudflare Durable Object "facet" — a dynamically-loaded worker instance cached by source hash.',
      }),
      e.jsx("h2", {
        style: { fontSize: "1.1rem", marginTop: "1.5rem", marginBottom: "0.5rem" },
        children: "How it works",
      }),
      e.jsxs("ul", {
        style: { paddingLeft: "1.5rem", color: "#aaa", lineHeight: 2 },
        children: [
          e.jsx("li", {
            children: "TanStack Start is built with Vite, producing server + client bundles",
          }),
          e.jsx("li", {
            children: "The server bundle exports a WinterCG-compatible fetch handler",
          }),
          e.jsx("li", { children: "A thin wrapper puts it in a DurableObject class" }),
          e.jsx("li", { children: "The Project DO loads it via LOADER as a dynamic worker facet" }),
          e.jsx("li", { children: "Client assets are served from the Project DO's workspace" }),
          e.jsx("li", { children: "SSR, streaming, and server functions all work inside the DO" }),
        ],
      }),
    ],
  });
}
export { i as component };
