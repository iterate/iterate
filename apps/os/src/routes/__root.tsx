import { memo, type ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { extractPublicConfigSchema } from "@iterate-com/shared/config";
import { AuthClientProvider } from "@iterate-com/auth/client";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import {
  DefaultErrorComponent,
  DefaultNotFoundComponent,
} from "@iterate-com/ui/components/route-defaults";
import { AppConfig } from "../config.ts";
import { orpcClient } from "../orpc/client.ts";
import appCss from "../styles.css?url";
import { fetchRootAuthSnapshot } from "~/lib/root-auth-snapshot.ts";
import type { RouterContext } from "~/router-context.ts";

const PublicConfigSchema = extractPublicConfigSchema(AppConfig);

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
  // defaultNotFoundComponent on the router already covers this, but the
  // reference implementation sets it explicitly on the root route too:
  // https://github.com/TanStack/router/blob/main/examples/react/start-basic/src/routes/__root.tsx
  notFoundComponent: () => <DefaultNotFoundComponent />,
});

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
