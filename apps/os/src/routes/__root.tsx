import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
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
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-background font-sans text-foreground antialiased">
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
