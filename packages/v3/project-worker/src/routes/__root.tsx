// __root.tsx — the console's shell: the document, the one stylesheet (console.css), the outlet.
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import consoleCss from "../console.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Control plane" },
    ],
    links: [
      { rel: "stylesheet", href: consoleCss },
      {
        rel: "icon",
        href: "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%278%27 fill=%27%23111%27/%3E%3Cpath d=%27M16 8v16%27 stroke=%27white%27 stroke-width=%274%27/%3E%3C/svg%3E",
      },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
