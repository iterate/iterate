import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OS dashboard" },
    ],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body
        style={{
          fontFamily: "system-ui",
          maxWidth: "44rem",
          margin: "2.5rem auto",
          padding: "0 1rem",
        }}
      >
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
