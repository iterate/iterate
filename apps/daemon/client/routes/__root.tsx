import { Suspense } from "react";
import { Outlet, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { Loader2Icon } from "lucide-react";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools.tsx";
import { AppErrorBoundary } from "../components/app-error-boundary.tsx";
import type { RouterContext } from "@/router.tsx";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  wrapInSuspense: true,
});

function RouterProgress() {
  const isTransitioning = useRouterState({
    select: (s) => s.isTransitioning,
  });

  if (!isTransitioning) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 h-1 bg-primary/20">
      <div className="h-full bg-primary animate-progress" />
    </div>
  );
}

function RootComponent() {
  return (
    <>
      <RouterProgress />
      <AppErrorBoundary>
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center">
              <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </AppErrorBoundary>
      <TanStackDevtools
        config={{
          position: "bottom-right",
        }}
        plugins={[
          {
            name: "Tanstack Router",
            render: <TanStackRouterDevtoolsPanel />,
          },
          TanStackQueryDevtools,
        ]}
      />
    </>
  );
}
