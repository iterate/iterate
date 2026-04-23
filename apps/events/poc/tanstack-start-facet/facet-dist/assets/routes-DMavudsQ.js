import { d as TSS_SERVER_FUNCTION, t as createServerFn } from "./createServerFn-Df2o8xb7.js";
//#region node_modules/@tanstack/start-server-core/dist/esm/createServerRpc.js
var createServerRpc = (serverFnMeta, splitImportFn) => {
  const url = "/_serverFn/" + serverFnMeta.id;
  return Object.assign(splitImportFn, {
    url,
    serverFnMeta,
    [TSS_SERVER_FUNCTION]: true,
  });
};
//#endregion
//#region src/routes/index.tsx?tss-serverfn-split
var getInfo_createServerFn_handler = createServerRpc(
  {
    id: "37e67d3ccf1225b287d37f9049d00eb6cc2b71abed75aa21d6cf45b6bbe99560",
    name: "getInfo",
    filename: "src/routes/index.tsx",
  },
  (opts) => getInfo.__executeServer(opts),
);
var getInfo = createServerFn({ method: "GET" }).handler(
  getInfo_createServerFn_handler,
  async () => ({
    time: /* @__PURE__ */ new Date().toISOString(),
    runtime: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    features: ["SSR", "oRPC", "OpenAPI + Scalar", "Streaming (SSE)", "SQLite CRUD"],
  }),
);
//#endregion
export { getInfo_createServerFn_handler };
