import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import css from "../styles.css?url";
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content: "Install and configure an Iterate voice device from your browser.",
      },
      { title: "Iterate Kit" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-background font-sans antialiased">
        {/* light only, like every os-next app: no theme picker, no system theme */}
        <AppProviders config={{}} devtools={null} forcedTheme="light">
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  ),
});
