/// <reference types="vite/client" />
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
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { AppProviders } from "@iterate-com/ui/apps/providers";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { DefaultErrorComponent } from "@iterate-com/ui/components/route-defaults";
import { AppConfig } from "../app.ts";
import { orpcClient } from "../orpc/client.ts";
import appCss from "../styles.css?url";
import type { RouterContext } from "../router.tsx";

const PublicConfigSchema = extractPublicConfigSchema(AppConfig);

export const Route = createRootRouteWithContext<RouterContext>()({
  loader: async () => {
    const config = PublicConfigSchema.parse(
      await (orpcClient.__internal as { publicConfig(input: {}): Promise<unknown> }).publicConfig(
        {},
      ),
    );
    return config;
  },
  staleTime: Number.POSITIVE_INFINITY,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Example" },
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

  return (
    <AppProviders
      config={config}
      devtools={<ExampleDevtools />}
      theme={{ defaultTheme: "light", enableSystem: false, storageKey: "example-theme" }}
    >
      <Outlet />
    </AppProviders>
  );
}

const ExampleDevtools = memo(function ExampleDevtools() {
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
        <Link to="/debug" className="text-sm text-primary hover:underline">
          Go to debug
        </Link>
      }
    />
  );
}
