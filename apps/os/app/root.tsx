import "./app.css";
import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { ThemeProvider } from "next-themes";
import { Suspense, useEffect, type PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  PostHogProvider as _PostHogProvider,
  PostHogErrorBoundary,
  type PostHogErrorBoundaryFallbackProps,
} from "posthog-js/react";
import { NuqsAdapter } from "nuqs/adapters/react-router/v7";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { Route } from "./+types/root";
import { GlobalLoading } from "./components/global-loading.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { queryClient, trpcClient, TrpcContext } from "./lib/trpc.ts";
import { ReactRouterServerContext } from "./context.ts";

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
        {children}
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
  return (
    <PostHogProvider
      apiKey={import.meta.env.VITE_POSTHOG_PUBLIC_KEY!}
      options={{
        api_host: import.meta.env.VITE_POSTHOG_PROXY_URI,
      }}
    >
      <PostHogErrorBoundary fallback={PostHogErrorFallback}>
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
              <Suspense fallback={<GlobalLoading />}>
                <NuqsAdapter>
                  <Outlet />
                  <ReactQueryDevtools initialIsOpen={false} />
                </NuqsAdapter>
              </Suspense>
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

export function HydrateFallback() {
  return <GlobalLoading />;
}

export const middleware: Route.MiddlewareFunction[] = [
  ({ request, context }) => {
    const PUBLIC_ROUTES = ["/login", "/no-access"];
    const url = new URL(request.url);
    if (PUBLIC_ROUTES.includes(url.pathname)) return;
    const session = context.get(ReactRouterServerContext).variables.session;
    if (!session)
      throw redirect(`/login?redirectUrl=${encodeURIComponent(url.pathname + url.search)}`);
  },
];

function PostHogErrorFallback({
  error,
  componentStack,
  exceptionEvent,
}: PostHogErrorBoundaryFallbackProps) {
  useEffect(() => {
    console.error({
      error,
      componentStack,
      exceptionEvent,
    });
  }, [error, componentStack, exceptionEvent]);

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>An unexpected error occurred</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      {componentStack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{componentStack}</code>
        </pre>
      )}
    </main>
  );
}
