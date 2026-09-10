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
    links: [{ rel: "stylesheet", href: consoleCss }],
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
