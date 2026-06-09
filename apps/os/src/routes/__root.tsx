import { memo, type ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
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

const ROOT_AUTH_SNAPSHOT_QUERY_KEY = ["__root-auth-snapshot"] as const;

type RootAuthSnapshot = {
  authSession: PublicSessionResponse;
  iterateAuthIssuer: string | undefined;
  currentProjectHostSlug: string | null;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({ context }) => {
    // Server requests always carry a start context with the authenticated
    // session (or null when signed out). Client-side navigations don't run
    // the server middleware, so reuse the snapshot the SSR pass dehydrated
    // into the query cache.
    const startContext = getGlobalStartContext();
    if (startContext?.iterateAuthSession === undefined) {
      const cached = context.queryClient.getQueryData<RootAuthSnapshot>(
        ROOT_AUTH_SNAPSHOT_QUERY_KEY,
      );
      return (
        cached ?? {
          authSession: { authenticated: false } satisfies PublicSessionResponse,
          iterateAuthIssuer: undefined,
          currentProjectHostSlug: null,
        }
      );
    }

    const snapshot: RootAuthSnapshot = {
      authSession: toPublicSession(startContext.iterateAuthSession),
      iterateAuthIssuer: startContext.config.iterateAuth?.issuer,
      currentProjectHostSlug: resolveCurrentProjectHostSlug({
        baseUrl: startContext.config.baseUrl,
        projectHostnameBases: startContext.projectHostnameBases ?? [],
        requestUrl: startContext.rawRequest?.url,
      }),
    };
    context.queryClient.setQueryData(ROOT_AUTH_SNAPSHOT_QUERY_KEY, snapshot);
    return snapshot;
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
