import { r as reactExports, T as jsxRuntimeExports } from "./worker-entry-Bt0TXpOD.js";
import { R as Route } from "./router-TcaY8nNQ.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
function Counter() {
  const initialData = Route.useLoaderData();
  const [count, setCount] = reactExports.useState(initialData.count);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", {
    children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h1", { children: "Counter" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", {
        children: "Client-side interactivity working alongside SSR.",
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "counter", children: count }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
        style: {
          display: "flex",
          gap: "1rem",
          justifyContent: "center",
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
            onClick: () => setCount((c) => c - 1),
            children: "- Decrement",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
            onClick: () => setCount((c) => c + 1),
            children: "+ Increment",
          }),
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", {
        style: {
          marginTop: "1rem",
          fontSize: "0.85rem",
          textAlign: "center",
        },
        children:
          "Initial value loaded via server function during SSR, then hydrated for client interactivity.",
      }),
    ],
  });
}
export { Counter as component };
