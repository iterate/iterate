/// <reference types="vite/client" />
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { RouterContext } from "../router.tsx";

function isProductionRuntime() {
  if (typeof document !== "undefined") {
    return import.meta.env.PROD;
  }
  return import.meta.env?.PROD ?? process.env.NODE_ENV === "production";
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: ({ match }) => {
    const isProd = isProductionRuntime();
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Registry" },
      ],
      links: match.context.appCssHrefs.map((href) => ({
        rel: "stylesheet",
        href,
        "data-app-css": "1",
      })),
      scripts: [
        ...(!isProd
          ? [
              {
                type: "module",
                children: `import RefreshRuntime from "/@react-refresh"
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true`,
              },
              { type: "module", src: "/@vite/client" },
            ]
          : []),
        {
          type: "module",
          src: isProd ? "/static/entry-client.js" : "/src/entry-client.tsx",
        },
      ],
    };
  },
  component: RootDocument,
});

function RootDocument() {
  const { queryClient } = Route.useRouteContext();
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
