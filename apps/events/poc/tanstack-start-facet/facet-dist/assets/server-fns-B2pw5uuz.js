import { c as createServerRpc } from "./createServerRpc--GzqEi4f.js";
import { a0 as createServerFn } from "./worker-entry-Bt0TXpOD.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
const echoTransform_createServerFn_handler = createServerRpc(
  {
    id: "f3ae7fbdf92997d56edb6ad544a8baa338da93266345b1f99e79a0149fe30543",
    name: "echoTransform",
    filename: "src/routes/server-fns.tsx",
  },
  (opts) => echoTransform.__executeServer(opts),
);
const echoTransform = createServerFn({
  method: "POST",
})
  .inputValidator((data) => {
    if (!data.text || data.text.length > 200) throw new Error("Text must be 1-200 chars");
    return data;
  })
  .handler(echoTransform_createServerFn_handler, async ({ data }) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data.text));
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return {
      original: data.text,
      upper: data.text.toUpperCase(),
      reversed: data.text.split("").reverse().join(""),
      length: data.text.length,
      sha256: hashHex,
      processedAt: /* @__PURE__ */ new Date().toISOString(),
      processedBy: "Durable Object Facet (TanStack Start SSR)",
    };
  });
const fetchExternalData_createServerFn_handler = createServerRpc(
  {
    id: "a67c4b73a356ae3a1d33059b44816740306a7d00805b408f3f4df61dabd0c14d",
    name: "fetchExternalData",
    filename: "src/routes/server-fns.tsx",
  },
  (opts) => fetchExternalData.__executeServer(opts),
);
const fetchExternalData = createServerFn({
  method: "GET",
}).handler(fetchExternalData_createServerFn_handler, async () => {
  const start = Date.now();
  try {
    const resp = await fetch("https://httpbin.org/json");
    const data = await resp.json();
    return {
      ok: true,
      status: resp.status,
      latencyMs: Date.now() - start,
      slideshow: data?.slideshow?.title ?? "unknown",
      fetchedAt: /* @__PURE__ */ new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      latencyMs: Date.now() - start,
      fetchedAt: /* @__PURE__ */ new Date().toISOString(),
    };
  }
});
const computeFib_createServerFn_handler = createServerRpc(
  {
    id: "fc0cf42d85c9a4ed1b9a943c0dcc8dabc8a5e27cc36271da1679ea8406a42bca",
    name: "computeFib",
    filename: "src/routes/server-fns.tsx",
  },
  (opts) => computeFib.__executeServer(opts),
);
const computeFib = createServerFn({
  method: "POST",
})
  .inputValidator((data) => {
    if (data.n < 1 || data.n > 40) throw new Error("n must be 1-40");
    return data;
  })
  .handler(computeFib_createServerFn_handler, async ({ data }) => {
    const start = Date.now();
    function fib(n) {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
    const result = fib(data.n);
    return {
      n: data.n,
      result,
      computeMs: Date.now() - start,
      computedAt: /* @__PURE__ */ new Date().toISOString(),
    };
  });
const generateId_createServerFn_handler = createServerRpc(
  {
    id: "7ccc88cb5fd3e0bedc82ce4d022149d8735ecacb7be1f0b8f65ce3ad4e22f706",
    name: "generateId",
    filename: "src/routes/server-fns.tsx",
  },
  (opts) => generateId.__executeServer(opts),
);
const generateId = createServerFn({
  method: "POST",
}).handler(generateId_createServerFn_handler, async () => {
  const id = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    uuid: id,
    randomHex: Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    generatedAt: /* @__PURE__ */ new Date().toISOString(),
  };
});
export {
  computeFib_createServerFn_handler,
  echoTransform_createServerFn_handler,
  fetchExternalData_createServerFn_handler,
  generateId_createServerFn_handler,
};
