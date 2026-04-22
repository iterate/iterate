import { T as jsxRuntimeExports } from "./worker-entry-Bt0TXpOD.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
function About() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", {
    children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h1", { children: "About" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", {
        children:
          'This POC demonstrates that a full TanStack Start application can run inside a Cloudflare Durable Object "facet" — a dynamically-loaded worker instance cached by source hash.',
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("h2", {
        style: {
          fontSize: "1.1rem",
          marginTop: "1.5rem",
          marginBottom: "0.5rem",
        },
        children: "How it works",
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("ul", {
        style: {
          paddingLeft: "1.5rem",
          color: "#aaa",
          lineHeight: 2,
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("li", {
            children: "TanStack Start is built with Vite, producing server + client bundles",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("li", {
            children: "The server bundle exports a WinterCG-compatible fetch handler",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("li", {
            children: "A thin wrapper puts it in a DurableObject class",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("li", {
            children: "The Project DO loads it via LOADER as a dynamic worker facet",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("li", {
            children: "Client assets are served from the Project DO's workspace",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("li", {
            children: "SSR, streaming, and server functions all work inside the DO",
          }),
        ],
      }),
    ],
  });
}
export { About as component };
