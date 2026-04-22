import { v as s, m as e } from "./index-CGt5-eaW.js";
function a() {
  const r = s.useLoaderData();
  return e.jsxs("main", {
    children: [
      e.jsx("h1", { children: "TanStack Start in a Durable Facet" }),
      e.jsx("p", {
        children:
          "This is a full TanStack Start app with SSR, file-based routing, and server functions — all running inside a Cloudflare Durable Object via the nested-facets dynamic worker system.",
      }),
      e.jsxs("p", {
        children: [
          "The HTML you see was ",
          e.jsx("strong", { children: "server-side rendered" }),
          " inside the DO, then streamed to the browser and hydrated with client-side React.",
        ],
      }),
      e.jsx("h2", {
        style: { fontSize: "1.1rem", marginTop: "1.5rem", marginBottom: "0.5rem" },
        children: "Server Info (from SSR loader)",
      }),
      e.jsxs("div", {
        style: {
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "1rem",
          fontFamily: "monospace",
          fontSize: "0.85rem",
          lineHeight: 1.8,
        },
        children: [
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "Server time:" }),
              " ",
              e.jsx("span", { style: { color: "#4ade80" }, children: r.time }),
            ],
          }),
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "Timestamp:" }),
              " ",
              r.timestamp,
            ],
          }),
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "Runtime:" }),
              " ",
              r.runtime,
            ],
          }),
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "Random:" }),
              " ",
              r.mathRandom,
            ],
          }),
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "fetch:" }),
              " ",
              r.hasGlobalFetch ? "yes" : "no",
            ],
          }),
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "crypto:" }),
              " ",
              r.hasCrypto ? "yes" : "no",
            ],
          }),
          e.jsxs("div", {
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "ReadableStream:" }),
              " ",
              r.hasReadableStream ? "yes" : "no",
            ],
          }),
        ],
      }),
      e.jsxs("p", {
        style: { marginTop: "1rem", fontSize: "0.85rem" },
        children: [
          "Refresh the page — the server time and random number will change (SSR, not cached). Navigate to ",
          e.jsx("a", { href: "/server-fns", style: { color: "#60a5fa" }, children: "/server-fns" }),
          " for interactive server function demos.",
        ],
      }),
    ],
  });
}
export { a as component };
