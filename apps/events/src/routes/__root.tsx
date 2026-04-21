/// <reference types="vite/client" />
import { memo, type ReactNode } from "react";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { FormDevtoolsPanel } from "@tanstack/react-form-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { extractPublicConfigSchema, getPublicConfig } from "@iterate-com/shared/apps/config";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { DefaultErrorComponent } from "@iterate-com/ui/components/route-defaults";
import { AppConfig } from "../app.ts";
import { defaultStreamViewSearch } from "../lib/stream-view-search.ts";
import { configureOrpcClient } from "../orpc/client.ts";
import appCss from "../styles.css?url";
import type { RouterContext } from "../router.tsx";

const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const loadPublicConfig = createServerFn({ method: "GET" }).handler(async ({ context }) =>
  PublicConfigSchema.parse(getPublicConfig(context.config, AppConfig)),
);

export const Route = createRootRouteWithContext<RouterContext>()({
  loader: async () => {
    const config = await loadPublicConfig();
    configureOrpcClient({ baseUrl: config.apiBaseUrl });
    return config;
  },
  staleTime: Number.POSITIVE_INFINITY,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Events" },
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
  const config = Route.useLoaderData();
  configureOrpcClient({ baseUrl: config.apiBaseUrl });

  return (
    <AppProviders config={config} devtools={<EventsDevtools />}>
      <Outlet />
    </AppProviders>
  );
}

const EventsDevtools = memo(function EventsDevtools() {
  return (
    <TanStackDevtools
      config={{ position: "bottom-left" }}
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
        <Link
          to="/streams/"
          search={defaultStreamViewSearch}
          className="text-sm text-primary hover:underline"
        >
          Go to streams
        </Link>
      }
    />
  );
}
