import { c as createServerRpc } from "./createServerRpc--GzqEi4f.js";
import { a0 as createServerFn } from "./worker-entry-Bt0TXpOD.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
const getServerInfo_createServerFn_handler = createServerRpc(
  {
    id: "bcc06e110064ff306a20f0e07346328125999211fd273f8af0a4f8e5fe43cba5",
    name: "getServerInfo",
    filename: "src/routes/index.tsx",
  },
  (opts) => getServerInfo.__executeServer(opts),
);
const getServerInfo = createServerFn({
  method: "GET",
}).handler(getServerInfo_createServerFn_handler, async () => {
  const now = /* @__PURE__ */ new Date();
  return {
    time: now.toISOString(),
    timestamp: now.getTime(),
    runtime:
      typeof navigator !== "undefined" ? navigator.userAgent || "Cloudflare Workers" : "unknown",
    // Prove we're in a worker environment
    hasGlobalFetch: typeof fetch === "function",
    hasCrypto: typeof crypto !== "undefined",
    hasReadableStream: typeof ReadableStream !== "undefined",
    mathRandom: Math.random(),
  };
});
export { getServerInfo_createServerFn_handler };
