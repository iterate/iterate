import { memo, type ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { createServerFn, getGlobalStartContext } from "@tanstack/react-start";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { AuthClientProvider, type PublicSessionResponse } from "@iterate-com/auth/client";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { DefaultErrorComponent } from "@iterate-com/ui/components/route-defaults";
import { AppConfig } from "../app.ts";
import { orpcClient } from "../orpc/client.ts";
import appCss from "../styles.css?url";
import {
  normalizeRequestHostname,
  resolveProjectSlugFromHostname,
} from "~/lib/project-host-routing.ts";
import type { RouterContext } from "~/router.tsx";

const PublicConfigSchema = extractPublicConfigSchema(AppConfig);

type RootAuthSnapshot = {
  authSession: PublicSessionResponse;
  iterateAuthIssuer: string | undefined;
  currentProjectHostSlug: string | null;
};

// Reads the request's authenticated session (resolved by the iterate auth
// request middleware from signed JWT claims) without any auth-worker
// roundtrip. During SSR this executes in-process; if a client navigation
// ever misses the dehydrated cache it fetches from the OS worker instead of
// treating the user as signed out.
const fetchRootAuthSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<RootAuthSnapshot> => {
    const startContext = getGlobalStartContext();
    return {
      authSession: toPublicSession(startContext?.iterateAuthSession),
      iterateAuthIssuer: startContext?.config.iterateAuth?.issuer,
      currentProjectHostSlug: resolveCurrentProjectHostSlug({
        baseUrl: startContext?.config.baseUrl,
        projectHostnameBases: startContext?.projectHostnameBases ?? [],
        requestUrl: startContext?.rawRequest?.url,
      }),
    };
  },
);

const rootAuthSnapshotQueryOptions = {
  queryKey: ["__root-auth-snapshot"] as const,
  queryFn: () => fetchRootAuthSnapshot(),
  // The session is a per-page-load snapshot: SSR seeds it and client-side
  // navigations reuse it. Claims changes propagate on the next full page
  // load (or token refresh), and the server independently re-authenticates
  // every request regardless of what the router believes.
  staleTime: Number.POSITIVE_INFINITY,
};

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context }) => {
    return await context.queryClient.ensureQueryData(rootAuthSnapshotQueryOptions);
  },
  loader: async ({ context }) => {
    const config = PublicConfigSchema.parse(await orpcClient.__internal.publicConfig({}));
    return {
      config,
      authSession: context.authSession ?? { authenticated: false },
    };
  },
  staleTime: Number.POSITIVE_INFINITY,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OS" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: iterateLogoAsset },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  errorComponent: RootErrorComponent,
});

function toPublicSession(
  session: import("@iterate-com/auth/server").AuthenticatedSession | null | undefined,
): PublicSessionResponse {
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    user: session.user,
    session: session.session,
  };
}

function resolveCurrentProjectHostSlug(input: {
  baseUrl: string | undefined;
  projectHostnameBases: string[];
  requestUrl: string | undefined;
}) {
  if (!input.requestUrl) return null;

  const dashboardHostname = input.baseUrl
    ? normalizeRequestHostname(new URL(input.baseUrl).hostname)
    : null;
  const requestHostname = normalizeRequestHostname(new URL(input.requestUrl).hostname);
  if (dashboardHostname && requestHostname === dashboardHostname) return null;

  return resolveProjectSlugFromHostname(requestHostname, input.projectHostnameBases) ?? null;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { config, authSession } = Route.useLoaderData();

  return (
    <AppProviders config={config} devtools={<OSDevtools />} forcedTheme="light">
      <AuthClientProvider initialSession={authSession}>
        <Outlet />
      </AuthClientProvider>
    </AppProviders>
  );
}

const OSDevtools = memo(function OSDevtools() {
  return (
    <TanStackDevtools
      config={{ position: "bottom-right" }}
      plugins={[
        {
          name: "TanStack Router",
          render: <TanStackRouterDevtoolsPanel />,
        },
        {
          name: "TanStack Query",
          render: <ReactQueryDevtoolsPanel />,
        },
        {
          name: "TanStack Form",
          render: <FormDevtoolsPanel />,
        },
      ]}
    />
  );
});

function RootErrorComponent(props: { error: unknown; reset: () => void }) {
  return (
    <DefaultErrorComponent
      {...props}
      secondaryAction={
        <Link to="/debug" className="text-sm text-primary hover:underline">
          Go to debug
        </Link>
      }
    />
  );
}
