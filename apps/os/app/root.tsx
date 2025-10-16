import "./app.css";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { ThemeProvider } from "next-themes";
import { Suspense, type PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { PostHogProvider as _PostHogProvider, PostHogErrorBoundary } from "posthog-js/react";
import type { Route } from "./+types/root";
import { AuthGuard } from "./components/auth-guard.tsx";
import { GlobalLoading } from "./components/global-loading.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { queryClient, trpcClient, TrpcContext } from "./lib/trpc.ts";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Fills up the network traffic with useless events in dev
const PostHogProvider = !import.meta.env.DEV
  ? _PostHogProvider
  : ({ children }: PropsWithChildren) => <>{children}</>;

export default function App() {
  return (
    <PostHogProvider
      apiKey={import.meta.env.VITE_POSTHOG_PUBLIC_KEY}
      options={{
        api_host: import.meta.env.VITE_POSTHOG_PROXY_URI,
      }}
    >
      <PostHogErrorBoundary fallback={<PostHogErrorFallback />}>
        <QueryClientProvider client={queryClient}>
          <TrpcContext.TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              enableColorScheme
              storageKey="theme"
              disableTransitionOnChange
            >
              <AuthGuard>
                <Suspense fallback={<GlobalLoading />}>
                  <Outlet />
                </Suspense>
              </AuthGuard>
              <Toaster />
            </ThemeProvider>
          </TrpcContext.TRPCProvider>
        </QueryClientProvider>
      </PostHogErrorBoundary>
    </PostHogProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}

function PostHogErrorFallback() {
  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred. Please try again later.</p>
    </main>
  );
}
