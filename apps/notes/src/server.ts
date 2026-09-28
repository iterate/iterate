import { createServerEntry } from "@tanstack/react-start/server-entry";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { appServerEntry } from "@iterate-com/ui/apps/server";
import { basePathOf, buildBasePath, underBasePath, withoutBuildBasePath } from "./base-path.ts";
export { BrowserSession } from "iterate/app-session";

/** TanStack Start's pages, their scripts and stylesheets under the request's base path
 *  (base-path.ts) — per request, since a proxied page names its own. */
const start = createStartHandler({
  handler: defaultStreamHandler,
  transformAssets: {
    createTransform: (context) => {
      const basePath = context.warmup ? buildBasePath : basePathOf(context.request.headers);
      return ({ url }) => underBasePath(basePath, url);
    },
    cache: false,
  },
});

const notes = appServerEntry(
  {
    // A page renders at the URL the browser addressed, its base path back on: at the stripped URL
    // the router would redirect to its canonical one, the base path on, which the edge strips
    // again. A server function is Start's `/_serverFn/<id>`, served as it came.
    fetch(request) {
      const basePath = basePathOf(request.headers);
      const addressed = new URL(request.url);
      if (!basePath || addressed.pathname.startsWith("/_serverFn/")) return start(request);
      addressed.pathname = `${basePath}${addressed.pathname}`;
      return start(new Request(addressed, request));
    },
  },
  {
    clientName: "iterate Notes",
    // routes/_auth/projects.index.tsx: the first project's page
    home: "/projects",
  },
);

/** Notes works through project ingress under the base path the edge says (base-path.ts). */
export default createServerEntry({
  fetch: (incoming) => notes.fetch(withoutBuildBasePath(incoming)),
});
