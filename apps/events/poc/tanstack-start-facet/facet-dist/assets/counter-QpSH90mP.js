import { R as s, k as o, m as e } from "./index-CGt5-eaW.js";
function a() {
  const i = s.useLoaderData(),
    [r, n] = o.useState(i.count);
  return e.jsxs("main", {
    children: [
      e.jsx("h1", { children: "Counter" }),
      e.jsx("p", { children: "Client-side interactivity working alongside SSR." }),
      e.jsx("div", { className: "counter", children: r }),
      e.jsxs("div", {
        style: { display: "flex", gap: "1rem", justifyContent: "center" },
        children: [
          e.jsx("button", { onClick: () => n((t) => t - 1), children: "- Decrement" }),
          e.jsx("button", { onClick: () => n((t) => t + 1), children: "+ Increment" }),
        ],
      }),
      e.jsx("p", {
        style: { marginTop: "1rem", fontSize: "0.85rem", textAlign: "center" },
        children:
          "Initial value loaded via server function during SSR, then hydrated for client interactivity.",
      }),
    ],
  });
}
export { a as component };
