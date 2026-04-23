import {
  a as __toESM,
  n as require_react,
  t as require_jsx_runtime,
} from "./jsx-runtime-B8ri5dzN.js";
import {
  X as readAsBuffer,
  i as StandardRPCLink,
  p as createORPCClient,
} from "./client.DrB9nq_G-HI4B2Z7U.js";
import { t as ClientPeer } from "./dist-DD-ghk-D.js";
import { n as RPCLink$1 } from "./fetch-BPivf5lv.js";
//#region node_modules/@orpc/client/dist/adapters/websocket/index.mjs
var import_react = /* @__PURE__ */ __toESM(require_react());
var WEBSOCKET_CONNECTING = 0;
var LinkWebsocketClient = class {
  peer;
  constructor(options) {
    const untilOpen = new Promise((resolve) => {
      if (options.websocket.readyState === WEBSOCKET_CONNECTING)
        options.websocket.addEventListener(
          "open",
          () => {
            resolve();
          },
          { once: true },
        );
      else resolve();
    });
    this.peer = new ClientPeer(async (message) => {
      await untilOpen;
      return options.websocket.send(message);
    });
    options.websocket.addEventListener("message", async (event) => {
      const message = event.data instanceof Blob ? await readAsBuffer(event.data) : event.data;
      this.peer.message(message);
    });
    options.websocket.addEventListener("close", () => {
      this.peer.close();
    });
  }
  async call(request, _options, _path, _input) {
    const response = await this.peer.request(request);
    return {
      ...response,
      body: () => Promise.resolve(response.body),
    };
  }
};
var RPCLink = class extends StandardRPCLink {
  constructor(options) {
    const linkClient = new LinkWebsocketClient(options);
    super(linkClient, {
      ...options,
      url: "http://orpc",
    });
  }
};
//#endregion
//#region src/routes/stream.tsx?tsr-split=component
var import_jsx_runtime = require_jsx_runtime();
function createRpcClient() {
  return createORPCClient(new RPCLink$1({ url: `${window.location.origin}/api/rpc` }));
}
function createWsClient() {
  const url = new URL("/api/rpc-ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const websocket = new WebSocket(url.toString());
  return {
    client: createORPCClient(new RPCLink({ websocket })),
    close: () => websocket.close(),
  };
}
function StreamPage() {
  const [transport, setTransport] = (0, import_react.useState)("openapi");
  const [count, setCount] = (0, import_react.useState)(20);
  const [minDelay, setMinDelay] = (0, import_react.useState)(50);
  const [maxDelay, setMaxDelay] = (0, import_react.useState)(300);
  const [lines, setLines] = (0, import_react.useState)([]);
  const [status, setStatus] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)(null);
  const logRef = (0, import_react.useRef)(null);
  const abortRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);
  async function startStream() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLines([]);
    setError(null);
    setStatus("connecting");
    const req = {
      count,
      minDelayMs: minDelay,
      maxDelayMs: maxDelay,
    };
    const transportClient =
      transport === "websocket"
        ? createWsClient()
        : {
            client: createRpcClient(),
            close: () => {},
          };
    try {
      const stream = await transportClient.client.test.randomLogStream(req, {
        signal: controller.signal,
      });
      setStatus("streaming");
      for await (const line of stream) {
        if (controller.signal.aborted) return;
        setLines((prev) => [...prev, line].slice(-500));
      }
      if (!controller.signal.aborted) setStatus("completed");
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err.message || String(err));
        setStatus("error");
      }
    } finally {
      transportClient.close();
    }
  }
  const isActive = status === "connecting" || status === "streaming";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
    style: {
      maxWidth: "none",
      display: "flex",
      flexDirection: "column",
      height: "calc(100vh - 49px)",
    },
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
        style: {
          padding: "1rem 2rem",
          borderBottom: "1px solid #222",
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              flexWrap: "wrap",
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
                style: {
                  fontSize: "1.2rem",
                  margin: 0,
                },
                children: "Log Stream",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatusBadge, { status }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
                style: {
                  color: "#555",
                  fontSize: "0.85rem",
                },
                children: [
                  transport === "websocket" ? "WebSocket" : "OpenAPI/SSE",
                  " · ",
                  lines.length,
                  " lines",
                ],
              }),
            ],
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
            style: {
              fontSize: "0.85rem",
              color: "#888",
              margin: "0.5rem 0 0.75rem",
            },
            children: [
              "Streams from an ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "async function*" }),
              " oRPC handler. Switch between OpenAPI (SSE over HTTP) and WebSocket transport.",
            ],
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
            style: {
              display: "flex",
              gap: "0.75rem",
              alignItems: "flex-end",
              flexWrap: "wrap",
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
                    style: {
                      fontSize: "0.7rem",
                      color: "#666",
                      display: "block",
                      marginBottom: "0.2rem",
                    },
                    children: "Transport",
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
                    style: {
                      display: "flex",
                      gap: "0.25rem",
                    },
                    children: ["openapi", "websocket"].map((t) =>
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                        "button",
                        {
                          onClick: () => setTransport(t),
                          disabled: isActive,
                          style: {
                            background: transport === t ? "#1e3a5f" : "#1a1a1a",
                            borderColor: transport === t ? "#2563eb" : "#333",
                            color: transport === t ? "#93c5fd" : "#888",
                            fontSize: "0.8rem",
                          },
                          children: t === "openapi" ? "OpenAPI (SSE)" : "WebSocket",
                        },
                        t,
                      ),
                    ),
                  }),
                ],
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumInput, {
                label: "Count",
                value: count,
                onChange: setCount,
                min: 1,
                max: 500,
                disabled: isActive,
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumInput, {
                label: "Min ms",
                value: minDelay,
                onChange: setMinDelay,
                min: 0,
                max: 1e4,
                disabled: isActive,
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumInput, {
                label: "Max ms",
                value: maxDelay,
                onChange: setMaxDelay,
                min: 1,
                max: 1e4,
                disabled: isActive,
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
                className: "btn-primary",
                onClick: startStream,
                disabled: isActive || maxDelay <= minDelay,
                children: isActive ? "Streaming..." : "Start",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
                onClick: () => {
                  abortRef.current?.abort();
                  setLines([]);
                  setStatus("idle");
                  setError(null);
                },
                children: "Clear",
              }),
            ],
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
            style: {
              marginTop: "0.5rem",
              padding: "0.4rem 0.6rem",
              background: "#111",
              border: "1px solid #222",
              borderRadius: 6,
              fontFamily: "monospace",
              fontSize: "0.7rem",
              color: "#888",
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                style: { color: "#555" },
                children: "procedure:",
              }),
              " ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                style: { color: "#4ade80" },
                children: "test.randomLogStream",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                style: { color: "#555" },
                children: " | transport:",
              }),
              " ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                style: { color: "#60a5fa" },
                children: transport === "websocket" ? "WebSocketRPCLink" : "RPCLink (fetch/SSE)",
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                style: { color: "#555" },
                children: " | endpoint:",
              }),
              " ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
                style: { color: "#aaa" },
                children:
                  transport === "websocket" ? "/api/rpc-ws" : "/api/rpc/test/randomLogStream",
              }),
            ],
          }),
        ],
      }),
      error &&
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
          style: {
            margin: "0.5rem 2rem",
            padding: "0.5rem 0.75rem",
            background: "#450a0a",
            border: "1px solid #7f1d1d",
            borderRadius: 6,
            color: "#fca5a5",
            fontSize: "0.85rem",
          },
          children: error,
        }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
        ref: logRef,
        style: {
          flex: 1,
          margin: 0,
          padding: "1rem 2rem",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          background: "#0a0a0a",
        },
        children: lines.length > 0 ? lines.join("\n") : "Click Start to stream log lines via oRPC.",
      }),
    ],
  });
}
function NumInput({ label, value, onChange, min, max, disabled }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
        style: {
          fontSize: "0.7rem",
          color: "#666",
          display: "block",
          marginBottom: "0.2rem",
        },
        children: label,
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
        type: "number",
        value,
        min,
        max,
        onChange: (e) => onChange(+e.target.value),
        disabled,
        style: {
          width: 70,
          textAlign: "center",
          fontFamily: "monospace",
        },
      }),
    ],
  });
}
function StatusBadge({ status }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
    style: {
      padding: "1px 6px",
      borderRadius: 4,
      fontSize: "0.7rem",
      border: `1px solid ${
        {
          idle: "#333",
          connecting: "#92400e",
          streaming: "#166534",
          completed: "#1d4ed8",
          error: "#991b1b",
        }[status]
      }`,
      color: {
        idle: "#888",
        connecting: "#fbbf24",
        streaming: "#4ade80",
        completed: "#93c5fd",
        error: "#fca5a5",
      }[status],
    },
    children: status,
  });
}
//#endregion
export { StreamPage as component };
