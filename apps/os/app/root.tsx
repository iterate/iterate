import "./app.css";
import {
  data,
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
import { NuqsAdapter } from "nuqs/adapters/react-router/v7";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { Route } from "./+types/root";
import { GlobalLoading } from "./components/global-loading.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { getQueryClient, trpcClient, TrpcContext } from "./lib/trpc.ts";
import { ReactRouterServerContext } from "./context.ts";
import { ErrorRenderer } from "./components/error-renderer.tsx";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
];

// by passing in the session data to the root layout,
// we can avoid fetching the session data in every client route
export async function loader({ context }: Route.LoaderArgs) {
  const { session } = context.get(ReactRouterServerContext).variables;
  return data({ session });
}

// No need to revalidate session data, its most likely to stay same
// session data is used mostly for the `useSessionUser` hook, which encapsulates all logic
export function shouldRevalidate() {
  return false;
}

export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          enableColorScheme
          storageKey="theme"
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Fills up the network traffic with useless events in dev
const PostHogProvider =
  import.meta.env.PROD && import.meta.env.VITE_POSTHOG_PUBLIC_KEY
    ? _PostHogProvider
    : ({ children }: PropsWithChildren) => <>{children}</>;

export default function App() {
  const queryClient = getQueryClient();

  return (
    <PostHogProvider
      apiKey={import.meta.env.VITE_POSTHOG_PUBLIC_KEY!}
      options={{
        api_host: import.meta.env.VITE_POSTHOG_PROXY_URI,
      }}
    >
      <PostHogErrorBoundary
        fallback={({ error, componentStack }) => (
          <ErrorRenderer
            message="An unexpected error occurred"
            details={error instanceof Error ? error.message : String(error)}
            stack={componentStack}
          />
        )}
      >
        <QueryClientProvider client={queryClient}>
          <TrpcContext.TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
            <Suspense fallback={<GlobalLoading />}>
              <NuqsAdapter>
                <Outlet />
                <Toaster />
                <ReactQueryDevtools initialIsOpen={false} />
              </NuqsAdapter>
            </Suspense>
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
    message = "Error";
    details = error.data || error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return <ErrorRenderer message={message} details={details} stack={stack} />;
}

export function HydrateFallback() {
  return <GlobalLoading />;
}
