import {
  r as reactExports,
  T as jsxRuntimeExports,
  a0 as createServerFn,
} from "./worker-entry-Bt0TXpOD.js";
import { l as createSsrRpc } from "./router-TcaY8nNQ.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
const echoTransform = createServerFn({
  method: "POST",
})
  .inputValidator((data) => {
    if (!data.text || data.text.length > 200) throw new Error("Text must be 1-200 chars");
    return data;
  })
  .handler(createSsrRpc("f3ae7fbdf92997d56edb6ad544a8baa338da93266345b1f99e79a0149fe30543"));
const fetchExternalData = createServerFn({
  method: "GET",
}).handler(createSsrRpc("a67c4b73a356ae3a1d33059b44816740306a7d00805b408f3f4df61dabd0c14d"));
const computeFib = createServerFn({
  method: "POST",
})
  .inputValidator((data) => {
    if (data.n < 1 || data.n > 40) throw new Error("n must be 1-40");
    return data;
  })
  .handler(createSsrRpc("fc0cf42d85c9a4ed1b9a943c0dcc8dabc8a5e27cc36271da1679ea8406a42bca"));
const generateId = createServerFn({
  method: "POST",
}).handler(createSsrRpc("7ccc88cb5fd3e0bedc82ce4d022149d8735ecacb7be1f0b8f65ce3ad4e22f706"));
function ServerFnsDemo() {
  const [echoInput, setEchoInput] = reactExports.useState("Hello from a Durable Facet!");
  const [echoResult, setEchoResult] = reactExports.useState(null);
  const [echoLoading, setEchoLoading] = reactExports.useState(false);
  const [fetchResult, setFetchResult] = reactExports.useState(null);
  const [fetchLoading, setFetchLoading] = reactExports.useState(false);
  const [fibN, setFibN] = reactExports.useState(30);
  const [fibResult, setFibResult] = reactExports.useState(null);
  const [fibLoading, setFibLoading] = reactExports.useState(false);
  const [idResult, setIdResult] = reactExports.useState(null);
  const [idLoading, setIdLoading] = reactExports.useState(false);
  async function handleEcho() {
    setEchoLoading(true);
    try {
      const result = await echoTransform({
        data: {
          text: echoInput,
        },
      });
      setEchoResult(result);
    } catch (err) {
      setEchoResult({
        error: err.message,
      });
    }
    setEchoLoading(false);
  }
  async function handleFetch() {
    setFetchLoading(true);
    try {
      const result = await fetchExternalData();
      setFetchResult(result);
    } catch (err) {
      setFetchResult({
        error: err.message,
      });
    }
    setFetchLoading(false);
  }
  async function handleFib() {
    setFibLoading(true);
    try {
      const result = await computeFib({
        data: {
          n: fibN,
        },
      });
      setFibResult(result);
    } catch (err) {
      setFibResult({
        error: err.message,
      });
    }
    setFibLoading(false);
  }
  async function handleGenId() {
    setIdLoading(true);
    try {
      const result = await generateId();
      setIdResult(result);
    } catch (err) {
      setIdResult({
        error: err.message,
      });
    }
    setIdLoading(false);
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("main", {
    children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h1", { children: "Server Functions Demo" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", {
        children: [
          "Each button calls a ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "createServerFn" }),
          " that executes ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", {
            children: "server-side inside the Durable Object",
          }),
          ". The client sends a POST to ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "/_serverFn/..." }),
          ", TanStack Start routes it to the handler, and the result comes back.",
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("section", {
        style: {
          marginTop: "1.5rem",
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("h2", {
            style: {
              fontSize: "1.1rem",
              marginBottom: "0.5rem",
            },
            children: "1. Echo + Transform (POST with validation)",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("p", {
            style: {
              fontSize: "0.85rem",
              marginBottom: "0.5rem",
            },
            children: [
              "Input is validated server-side (1-200 chars), then transformed with SHA-256 hashing via ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "crypto.subtle" }),
              ".",
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            style: {
              display: "flex",
              gap: "0.5rem",
              marginBottom: "0.5rem",
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("input", {
                type: "text",
                value: echoInput,
                onChange: (e) => setEchoInput(e.target.value),
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
              /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
                onClick: handleEcho,
                disabled: echoLoading,
                children: echoLoading ? "Processing..." : "Transform",
              }),
            ],
          }),
          echoResult && /* @__PURE__ */ jsxRuntimeExports.jsx(ResultBox, { data: echoResult }),
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("section", {
        style: {
          marginTop: "1.5rem",
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("h2", {
            style: {
              fontSize: "1.1rem",
              marginBottom: "0.5rem",
            },
            children: "2. External API Fetch (outbound from DO)",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("p", {
            style: {
              fontSize: "0.85rem",
              marginBottom: "0.5rem",
            },
            children: [
              "Server function fetches ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "httpbin.org/json" }),
              " from inside the Durable Object, proving outbound HTTP works.",
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
            onClick: handleFetch,
            disabled: fetchLoading,
            children: fetchLoading ? "Fetching..." : "Fetch External API",
          }),
          fetchResult && /* @__PURE__ */ jsxRuntimeExports.jsx(ResultBox, { data: fetchResult }),
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("section", {
        style: {
          marginTop: "1.5rem",
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("h2", {
            style: {
              fontSize: "1.1rem",
              marginBottom: "0.5rem",
            },
            children: "3. Fibonacci (CPU-bound in DO)",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("p", {
            style: {
              fontSize: "0.85rem",
              marginBottom: "0.5rem",
            },
            children:
              "Recursive fibonacci computed server-side. Proves CPU-bound work runs in the DO.",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", {
            style: {
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              marginBottom: "0.5rem",
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: "fib(",
              }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("input", {
                type: "number",
                value: fibN,
                min: 1,
                max: 40,
                onChange: (e) => setFibN(Number(e.target.value)),
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
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", {
                style: {
                  color: "#888",
                },
                children: ")",
              }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
                onClick: handleFib,
                disabled: fibLoading,
                children: fibLoading ? "Computing..." : "Compute",
              }),
            ],
          }),
          fibResult && /* @__PURE__ */ jsxRuntimeExports.jsx(ResultBox, { data: fibResult }),
        ],
      }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("section", {
        style: {
          marginTop: "1.5rem",
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("h2", {
            style: {
              fontSize: "1.1rem",
              marginBottom: "0.5rem",
            },
            children: "4. Crypto UUID (server-side crypto API)",
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("p", {
            style: {
              fontSize: "0.85rem",
              marginBottom: "0.5rem",
            },
            children: [
              "Generates UUIDs and random bytes using ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "crypto.randomUUID()" }),
              " and ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", {
                children: "crypto.getRandomValues()",
              }),
              " inside the DO.",
            ],
          }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", {
            onClick: handleGenId,
            disabled: idLoading,
            children: idLoading ? "Generating..." : "Generate ID",
          }),
          idResult && /* @__PURE__ */ jsxRuntimeExports.jsx(ResultBox, { data: idResult }),
        ],
      }),
    ],
  });
}
function ResultBox({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("pre", {
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
    children: JSON.stringify(data, null, 2),
  });
}
export { ServerFnsDemo as component };
