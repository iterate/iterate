import { k as n, m as e, o as a, q as o } from "./index-CGt5-eaW.js";
const C = a({ method: "POST" }).handler(
    o("f3ae7fbdf92997d56edb6ad544a8baa338da93266345b1f99e79a0149fe30543"),
  ),
  E = a({ method: "GET" }).handler(
    o("a67c4b73a356ae3a1d33059b44816740306a7d00805b408f3f4df61dabd0c14d"),
  ),
  O = a({ method: "POST" }).handler(
    o("fc0cf42d85c9a4ed1b9a943c0dcc8dabc8a5e27cc36271da1679ea8406a42bca"),
  ),
  B = a({ method: "POST" }).handler(
    o("7ccc88cb5fd3e0bedc82ce4d022149d8735ecacb7be1f0b8f65ce3ad4e22f706"),
  );
function z() {
  const [r, T] = n.useState("Hello from a Durable Facet!"),
    [c, i] = n.useState(null),
    [d, l] = n.useState(!1),
    [m, h] = n.useState(null),
    [u, f] = n.useState(!1),
    [b, R] = n.useState(30),
    [x, g] = n.useState(null),
    [p, j] = n.useState(!1),
    [y, S] = n.useState(null),
    [v, F] = n.useState(!1);
  async function I() {
    l(!0);
    try {
      const t = await C({ data: { text: r } });
      i(t);
    } catch (t) {
      i({ error: t.message });
    }
    l(!1);
  }
  async function D() {
    f(!0);
    try {
      const t = await E();
      h(t);
    } catch (t) {
      h({ error: t.message });
    }
    f(!1);
  }
  async function P() {
    j(!0);
    try {
      const t = await O({ data: { n: b } });
      g(t);
    } catch (t) {
      g({ error: t.message });
    }
    j(!1);
  }
  async function k() {
    F(!0);
    try {
      const t = await B();
      S(t);
    } catch (t) {
      S({ error: t.message });
    }
    F(!1);
  }
  return e.jsxs("main", {
    children: [
      e.jsx("h1", { children: "Server Functions Demo" }),
      e.jsxs("p", {
        children: [
          "Each button calls a ",
          e.jsx("code", { children: "createServerFn" }),
          " that executes ",
          e.jsx("strong", { children: "server-side inside the Durable Object" }),
          ". The client sends a POST to ",
          e.jsx("code", { children: "/_serverFn/..." }),
          ", TanStack Start routes it to the handler, and the result comes back.",
        ],
      }),
      e.jsxs("section", {
        style: { marginTop: "1.5rem" },
        children: [
          e.jsx("h2", {
            style: { fontSize: "1.1rem", marginBottom: "0.5rem" },
            children: "1. Echo + Transform (POST with validation)",
          }),
          e.jsxs("p", {
            style: { fontSize: "0.85rem", marginBottom: "0.5rem" },
            children: [
              "Input is validated server-side (1-200 chars), then transformed with SHA-256 hashing via ",
              e.jsx("code", { children: "crypto.subtle" }),
              ".",
            ],
          }),
          e.jsxs("div", {
            style: { display: "flex", gap: "0.5rem", marginBottom: "0.5rem" },
            children: [
              e.jsx("input", {
                type: "text",
                value: r,
                onChange: (t) => T(t.target.value),
                style: {
                  flex: 1,
                  padding: "0.5rem",
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: 6,
                  color: "#e0e0e0",
                  fontFamily: "monospace",
                },
              }),
              e.jsx("button", {
                onClick: I,
                disabled: d,
                children: d ? "Processing..." : "Transform",
              }),
            ],
          }),
          c && e.jsx(s, { data: c }),
        ],
      }),
      e.jsxs("section", {
        style: { marginTop: "1.5rem" },
        children: [
          e.jsx("h2", {
            style: { fontSize: "1.1rem", marginBottom: "0.5rem" },
            children: "2. External API Fetch (outbound from DO)",
          }),
          e.jsxs("p", {
            style: { fontSize: "0.85rem", marginBottom: "0.5rem" },
            children: [
              "Server function fetches ",
              e.jsx("code", { children: "httpbin.org/json" }),
              " from inside the Durable Object, proving outbound HTTP works.",
            ],
          }),
          e.jsx("button", {
            onClick: D,
            disabled: u,
            children: u ? "Fetching..." : "Fetch External API",
          }),
          m && e.jsx(s, { data: m }),
        ],
      }),
      e.jsxs("section", {
        style: { marginTop: "1.5rem" },
        children: [
          e.jsx("h2", {
            style: { fontSize: "1.1rem", marginBottom: "0.5rem" },
            children: "3. Fibonacci (CPU-bound in DO)",
          }),
          e.jsx("p", {
            style: { fontSize: "0.85rem", marginBottom: "0.5rem" },
            children:
              "Recursive fibonacci computed server-side. Proves CPU-bound work runs in the DO.",
          }),
          e.jsxs("div", {
            style: { display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" },
            children: [
              e.jsx("span", { style: { color: "#888" }, children: "fib(" }),
              e.jsx("input", {
                type: "number",
                value: b,
                min: 1,
                max: 40,
                onChange: (t) => R(Number(t.target.value)),
                style: {
                  width: 60,
                  padding: "0.5rem",
                  background: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: 6,
                  color: "#e0e0e0",
                  fontFamily: "monospace",
                  textAlign: "center",
                },
              }),
              e.jsx("span", { style: { color: "#888" }, children: ")" }),
              e.jsx("button", {
                onClick: P,
                disabled: p,
                children: p ? "Computing..." : "Compute",
              }),
            ],
          }),
          x && e.jsx(s, { data: x }),
        ],
      }),
      e.jsxs("section", {
        style: { marginTop: "1.5rem" },
        children: [
          e.jsx("h2", {
            style: { fontSize: "1.1rem", marginBottom: "0.5rem" },
            children: "4. Crypto UUID (server-side crypto API)",
          }),
          e.jsxs("p", {
            style: { fontSize: "0.85rem", marginBottom: "0.5rem" },
            children: [
              "Generates UUIDs and random bytes using ",
              e.jsx("code", { children: "crypto.randomUUID()" }),
              " and ",
              e.jsx("code", { children: "crypto.getRandomValues()" }),
              " inside the DO.",
            ],
          }),
          e.jsx("button", {
            onClick: k,
            disabled: v,
            children: v ? "Generating..." : "Generate ID",
          }),
          y && e.jsx(s, { data: y }),
        ],
      }),
    ],
  });
}
function s({ data: r }) {
  return e.jsx("pre", {
    style: {
      background: "#111",
      border: "1px solid #333",
      borderRadius: 8,
      padding: "0.75rem",
      fontFamily: "monospace",
      fontSize: "0.8rem",
      lineHeight: 1.6,
      overflow: "auto",
      marginTop: "0.5rem",
      color: "#4ade80",
    },
    children: JSON.stringify(r, null, 2),
  });
}
export { z as component };
