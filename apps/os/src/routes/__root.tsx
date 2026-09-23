import { createRootRoute, HeadContent, Outlet, Scripts, useHydrated } from "@tanstack/react-router";
import css from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/iterate-logo.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  // `data-hydrated` is false in the server's HTML and true once React owns the page: the specs'
  // hydration-waiter (specs/AGENTS.md) waits on it before touching controls that do nothing yet.
  const hydrated = useHydrated();
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        className="min-h-svh bg-background font-sans text-foreground antialiased"
        data-hydrated={hydrated}
      >
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
