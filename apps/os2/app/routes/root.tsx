import "../styles.css";
import { Suspense, type PropsWithChildren, type ReactNode } from "react";
import { Outlet, createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { PostHogProvider as _PostHogProvider } from "posthog-js/react";
import { Toaster } from "sonner";
import { AppErrorBoundary } from "../components/app-error-boundary.tsx";
import type { TanstackRouterContext } from "../router.tsx";

const PostHogProvider =
  import.meta.env.PROD && import.meta.env.VITE_POSTHOG_PUBLIC_KEY
    ? _PostHogProvider
    : ({ children }: PropsWithChildren) => <>{children}</>;

export const Route = createRootRouteWithContext<TanstackRouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OS2" },
    ],
    links: [{ rel: "icon", href: "/favicon.ico" }],
  }),
  component: RootComponent,
  wrapInSuspense: true,
});

function RootComponent() {
  return (
    <RootDocument>
      <AppErrorBoundary>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center">
              <div className="text-muted-foreground">Loading...</div>
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </AppErrorBoundary>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <PostHogProvider
          apiKey={import.meta.env.VITE_POSTHOG_PUBLIC_KEY!}
          options={{
            api_host: import.meta.env.VITE_POSTHOG_PROXY_URI,
          }}
        >
          {children}
        </PostHogProvider>
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}
