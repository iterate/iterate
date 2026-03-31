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
import { AppProviders } from "@iterate-com/ui/apps/providers";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { DefaultErrorComponent } from "@iterate-com/ui/components/route-defaults";
import appCss from "../styles.css?url";
import type { RouterContext } from "../router.tsx";

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "fake-os" },
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
  return (
    <AppProviders config={{}} devtools={<ExampleDevtools />}>
      <Outlet />
    </AppProviders>
  );
}

const ExampleDevtools = memo(function ExampleDevtools() {
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
        <Link to="/deployments" className="text-sm text-primary hover:underline">
          Go to deployments
        </Link>
      }
    />
  );
}
