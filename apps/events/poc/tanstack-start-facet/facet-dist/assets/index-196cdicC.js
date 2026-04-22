import { T as jsxRuntimeExports } from "./worker-entry-Bt0TXpOD.js";
import { m as Route } from "./router-TcaY8nNQ.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
function Home() {
  const data = Route.useLoaderData();
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", {
    children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h1", {
        children: "TanStack Start in a Durable Facet",
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", {
        children:
          "This is a full TanStack Start app with SSR, file-based routing, and server functions — all running inside a Cloudflare Durable Object via the nested-facets dynamic worker system.",
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", {
        children: [
          "The HTML you see was ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "server-side rendered" }),
          " inside the DO, then streamed to the browser and hydrated with client-side React.",
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("h2", {
        style: {
          fontSize: "1.1rem",
          marginTop: "1.5rem",
          marginBottom: "0.5rem",
        },
        children: "Server Info (from SSR loader)",
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
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
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "Server time:",
              }),
              " ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#4ade80",
                },
                children: data.time,
              }),
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "Timestamp:",
              }),
              " ",
              data.timestamp,
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "Runtime:",
              }),
              " ",
              data.runtime,
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "Random:",
              }),
              " ",
              data.mathRandom,
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "fetch:",
              }),
              " ",
              data.hasGlobalFetch ? "yes" : "no",
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "crypto:",
              }),
              " ",
              data.hasCrypto ? "yes" : "no",
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "ReadableStream:",
              }),
              " ",
              data.hasReadableStream ? "yes" : "no",
            ],
          }),
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", {
        style: {
          marginTop: "1rem",
          fontSize: "0.85rem",
        },
        children: [
          "Refresh the page — the server time and random number will change (SSR, not cached). Navigate to ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("a", {
            href: "/server-fns",
            style: {
              color: "#60a5fa",
            },
            children: "/server-fns",
          }),
          " for interactive server function demos.",
        ],
      }),
    ],
  });
}
export { Home as component };
