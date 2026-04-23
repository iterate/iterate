import { t as e } from "./jsx-runtime-ByY1xr43.js";
import { t } from "./index-BNby28Aj.js";
var n = e(),
  r = () => {
    let e = t.useLoaderData();
    return (0, n.jsxs)(`main`, {
      children: [
        (0, n.jsx)(`h1`, { children: `oRPC + TanStack Start` }),
        (0, n.jsx)(`p`, {
          children: `Full-stack app running on Cloudflare Workers with oRPC typed API, streaming, and Scalar docs.`,
        }),
        (0, n.jsx)(`pre`, { children: JSON.stringify(e, null, 2) }),
        (0, n.jsxs)(`div`, {
          style: { display: `flex`, gap: `0.5rem`, marginTop: `1rem`, flexWrap: `wrap` },
          children: [
            (0, n.jsx)(`a`, {
              href: `/api/docs`,
              target: `_blank`,
              children: (0, n.jsx)(`button`, { children: `API Docs (Scalar)` }),
            }),
            (0, n.jsx)(`a`, {
              href: `/api/openapi.json`,
              target: `_blank`,
              children: (0, n.jsx)(`button`, { children: `OpenAPI Spec` }),
            }),
            (0, n.jsx)(`a`, {
              href: `/api/ping`,
              children: (0, n.jsx)(`button`, { children: `GET /api/ping` }),
            }),
          ],
        }),
      ],
    });
  };
export { r as component };
