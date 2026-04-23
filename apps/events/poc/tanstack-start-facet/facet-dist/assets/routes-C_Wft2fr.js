import { t as require_jsx_runtime } from "./jsx-runtime-B9Euz7RS.js";
import { t as Route } from "./routes-D_CvTT9A.js";
//#region src/routes/index.tsx?tsr-split=component
var import_jsx_runtime = require_jsx_runtime();
var SplitComponent = () => {
  const data = Route.useLoaderData();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", { children: "oRPC + TanStack Start" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
        children:
          "Full-stack app running on Cloudflare Workers with oRPC typed API, streaming, and Scalar docs.",
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
        children: JSON.stringify(data, null, 2),
      }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
        style: {
          display: "flex",
          gap: "0.5rem",
          marginTop: "1rem",
          flexWrap: "wrap",
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
            href: "/api/docs",
            target: "_blank",
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
              children: "API Docs (Scalar)",
            }),
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
            href: "/api/openapi.json",
            target: "_blank",
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
              children: "OpenAPI Spec",
            }),
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
            href: "/api/ping",
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
              children: "GET /api/ping",
            }),
          }),
        ],
      }),
    ],
  });
};
//#endregion
export { SplitComponent as component };
